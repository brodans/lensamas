import type { IncomingMessage, ServerResponse } from 'node:http';
import * as https from 'node:https';

import {
  MALANG_ORIGIN,
  MALANG_PAGE_URL,
  MALANG_STREAM_BASE,
  TULUNGAGUNG_STREAM_BASE,
} from './config.js';
import { readOpaqueQuery, rememberOpaqueQuery } from './opaque-query.js';
import {
  sendCircuitResponse,
  sendStreamGatewayError,
  sendUpstreamStreamError,
} from './regional-hls.js';
import {
  noteUpstreamStatus,
  noteStreamHealthy,
  noteStreamUnreachable,
  streamCooldown,
} from './stream-circuit.js';

const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const TULUNGAGUNG_BASE = new URL(
  TULUNGAGUNG_STREAM_BASE.endsWith('/') ? TULUNGAGUNG_STREAM_BASE : `${TULUNGAGUNG_STREAM_BASE}/`
);
const malangPage = new URL(MALANG_PAGE_URL);

let malangSessionCookie = '';
let malangSessionUntil = 0;

const malangBase = new URL(MALANG_STREAM_BASE.endsWith('/') ? MALANG_STREAM_BASE : `${MALANG_STREAM_BASE}/`);
const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

function safeAsset(asset: string): boolean {
  return Boolean(
    asset &&
    asset.length <= 512 &&
    !asset.startsWith('/') &&
    !asset.includes('\\') &&
    !asset.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

interface UpstreamResult {
  response: IncomingMessage;
  finalUrl: URL;
}

function requestUpstream(
  target: URL,
  headers: Record<string, string>,
  rejectUnauthorized: boolean,
  validate: (url: URL) => boolean
): Promise<UpstreamResult> {
  if (!validate(target)) return Promise.reject(new Error('URL berada di luar host/path yang diizinkan.'));

  const open = (url: URL, redirects: number): Promise<UpstreamResult> =>
    new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: 'GET',
          rejectUnauthorized,
          agent: upstreamAgent,
          headers,
        },
        (response) => {
          const status = response.statusCode || 0;
          const location = response.headers.location;
          if (status >= 300 && status < 400 && location) {
            response.resume();
            if (redirects >= MAX_REDIRECTS) {
              reject(new Error('Terlalu banyak redirect dari sumber stream.'));
              return;
            }
            try {
              const redirected = new URL(location, url);
              if (!validate(redirected)) {
                reject(new Error('Redirect berada di luar host/path yang diizinkan.'));
                return;
              }
              void open(redirected, redirects + 1).then(resolve, reject);
            } catch {
              reject(new Error('Redirect dari sumber stream tidak valid.'));
            }
            return;
          }
          resolve({ response, finalUrl: url });
        }
      );
      request.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
        request.destroy(new Error('Koneksi ke sumber stream habis waktu.'));
      });
      request.on('error', reject);
      request.end();
    });

  return open(target, 0);
}

function isMalangSessionTarget(target: URL): boolean {
  return target.origin === malangBase.origin &&
    target.protocol === malangPage.protocol &&
    target.hostname === malangPage.hostname &&
    target.port === malangPage.port &&
    target.pathname === malangPage.pathname;
}

function readSetCookie(headers: Record<string, string | string[] | undefined>): string {
  const value = headers['set-cookie'];
  if (!value) return '';
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => item.split(';')[0]).filter(Boolean).join('; ');
}

async function getMalangSessionCookie(): Promise<string> {
  if (malangSessionCookie && malangSessionUntil > Date.now()) return malangSessionCookie;

  try {
    const result = await requestUpstream(
      malangPage,
      {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: malangPage.href,
        'User-Agent': USER_AGENT,
      },
      false,
      isMalangSessionTarget
    );
    result.response.resume();
    if ((result.response.statusCode || 0) >= 200 && (result.response.statusCode || 0) < 300) {
      malangSessionCookie = readSetCookie(result.response.headers);
      malangSessionUntil = Date.now() + 10 * 60 * 1000;
    }
  } catch {
    // Stream request tetap dicoba tanpa cookie when warm-up tidak tersedia.
  }
  return malangSessionCookie;
}

function readPlaylist(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PLAYLIST_BYTES) {
        response.destroy();
        finish(new Error('Manifest HLS terlalu besar.'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => finish());
    response.on('aborted', () => finish(new Error('Respons manifest HLS terputus.')));
    response.on('error', (error) => finish(error));
  });
}

function rewritePlaylist(
  text: string,
  sourceUrl: string,
  toProxyUrl: (absolute: URL) => string | null
): string {
  const source = new URL(sourceUrl);
  const resolveUri = (rawUri: string): string | null => {
    try {
      return toProxyUrl(new URL(rawUri.trim(), source));
    } catch {
      return null;
    }
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (original, uri: string) => {
          const proxied = resolveUri(uri);
          return proxied ? `URI="${proxied.replace(/"/g, '%22')}"` : original;
        });
      }
      return resolveUri(trimmed) || line;
    })
    .join('\n');
}

interface StreamCircuit {
  source: string;
  cameraId: string;
}

async function proxyUpstream(
  res: ServerResponse,
  target: URL,
  headers: Record<string, string>,
  rejectUnauthorized: boolean,
  validate: (url: URL) => boolean,
  rewrite: (body: string, target: URL) => string,
  circuit: StreamCircuit,
  onResponse?: (response: IncomingMessage) => void
): Promise<void> {
  const cooldown = streamCooldown(circuit.source, circuit.cameraId);
  if (cooldown) {
    sendCircuitResponse(res, cooldown, `Stream ${circuit.source} sedang tidak tersedia.`);
    return;
  }
  let upstream: IncomingMessage | null = null;
  try {
    const result = await requestUpstream(target, headers, rejectUnauthorized, validate);
    upstream = result.response;
    onResponse?.(upstream);
    const finalUrl = result.finalUrl;
    const status = upstream.statusCode || 0;
    if (status < 200 || status >= 300) {
      upstream.resume();
      noteUpstreamStatus(circuit.source, circuit.cameraId, status);
      sendUpstreamStreamError(res, status, `Sumber stream membalas HTTP ${status}.`, { upstreamStatus: status });
      return;
    }
    noteStreamHealthy(circuit.source, circuit.cameraId);

    const contentType = String(upstream.headers['content-type'] || '');
    const isPlaylist = /\.m3u8$/i.test(finalUrl.pathname) || /mpegurl/i.test(contentType);
    if (isPlaylist) {
      const body = await readPlaylist(upstream);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(rewrite(body.toString('utf8'), finalUrl));
      return;
    }

    res.statusCode = upstream.statusCode || 200;
    res.setHeader('Content-Type', contentType || 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    for (const header of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = upstream.headers[header];
      if (value) res.setHeader(header, value);
    }

    const responseStream = upstream;
    res.on('close', () => {
      try {
        responseStream.destroy();
      } catch {
        /* noop */
      }
    });
    responseStream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    responseStream.pipe(res);
  } catch (error) {
    if (upstream) upstream.destroy();
    noteStreamUnreachable(circuit.source, circuit.cameraId);
    if (!res.headersSent) {
      sendStreamGatewayError(res, `Proxy stream gagal: ${(error as Error).message}`);
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

function isMalangTarget(target: URL): boolean {
  if (target.protocol !== malangBase.protocol || target.hostname !== malangBase.hostname) return false;
  if (target.port !== malangBase.port) return false;
  const prefix = malangBase.pathname.endsWith('/') ? malangBase.pathname : `${malangBase.pathname}/`;
  return target.pathname.startsWith(prefix);
}

function rewriteMalangPlaylist(text: string, sourceUrl: string, streamId: string): string {
  const basePrefix = malangBase.pathname.endsWith('/') ? malangBase.pathname : `${malangBase.pathname}/`;
  return rewritePlaylist(text, sourceUrl, (absolute) => {
    if (!isMalangTarget(absolute)) return null;
    const asset = absolute.pathname.slice(basePrefix.length);
    if (!safeAsset(asset)) return null;
    const params = new URLSearchParams({
      source: 'malang',
      streamId,
      asset,
    });
    if (absolute.search) params.set('queryId', rememberOpaqueQuery(`malang:${streamId}`, absolute.search.slice(1)));
    return `/api/hls-proxy?${params.toString()}`;
  });
}

export async function handleMalangStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url || '', 'http://localhost');
  const streamId = requestUrl.searchParams.get('streamId') || '';
  const asset = requestUrl.searchParams.get('asset') || '';
  const queryId = requestUrl.searchParams.get('queryId');
  const sourceQuery = readOpaqueQuery(`malang:${streamId}`, queryId);

  if (!/^\d{1,40}$/.test(streamId) || !safeAsset(asset) || (queryId && !sourceQuery)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Parameter stream Malang tidak valid.' }));
    return;
  }

  const target = new URL(asset === 'index.m3u8' ? `${streamId}.m3u8` : asset, malangBase);
  if (sourceQuery) target.search = sourceQuery;
  const headers: Record<string, string> = {
    Accept: '*/*',
    Origin: MALANG_ORIGIN,
    Referer: MALANG_PAGE_URL,
    'User-Agent': USER_AGENT,
  };
  const sessionCookie = await getMalangSessionCookie();
  if (sessionCookie) headers.Cookie = sessionCookie;
  if (req.headers.range) headers.Range = String(req.headers.range);

  await proxyUpstream(
    res,
    target,
    headers,
    false,
    isMalangTarget,
    (body, source) => rewriteMalangPlaylist(body, source.href, streamId),
    { source: 'malang', cameraId: streamId },
    (response) => {
      const refreshed = readSetCookie(response.headers);
      if (refreshed) {
        malangSessionCookie = refreshed;
        malangSessionUntil = Date.now() + 10 * 60 * 1000;
      }
    }
  );
}

function isTulungagungTarget(target: URL): boolean {
  return target.protocol === TULUNGAGUNG_BASE.protocol &&
    target.hostname === TULUNGAGUNG_BASE.hostname &&
    target.port === TULUNGAGUNG_BASE.port &&
    target.pathname.startsWith(TULUNGAGUNG_BASE.pathname);
}

function rewriteTulungagungPlaylist(text: string, sourceUrl: string, sourceCode: string): string {
  const prefix = TULUNGAGUNG_BASE.pathname;
  return rewritePlaylist(text, sourceUrl, (absolute) => {
    if (!isTulungagungTarget(absolute)) return null;
    const asset = absolute.pathname.slice(prefix.length);
    if (!safeAsset(asset)) return null;
    const params = new URLSearchParams({ source: 'tulungagung', src: sourceCode, asset });
    if (absolute.search) params.set('queryId', rememberOpaqueQuery(`tulungagung:${sourceCode}`, absolute.search.slice(1)));
    return `/api/hls-proxy?${params.toString()}`;
  });
}

export async function handleTulungagungStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url || '', 'http://localhost');
  const sourceCode = requestUrl.searchParams.get('src') || '';
  const asset = requestUrl.searchParams.get('asset') || 'stream.m3u8';
  const queryId = requestUrl.searchParams.get('queryId');
  const sourceQuery = readOpaqueQuery(`tulungagung:${sourceCode}`, queryId);

  if (!/^[A-Za-z0-9_-]{1,160}$/.test(sourceCode) || !safeAsset(asset) || (queryId && !sourceQuery)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Parameter stream Tulungagung tidak valid.' }));
    return;
  }

  const target = asset === 'stream.m3u8'
    ? new URL('stream.m3u8', TULUNGAGUNG_BASE)
    : new URL(asset, TULUNGAGUNG_BASE);
  if (asset === 'stream.m3u8') {
    target.search = new URLSearchParams({ src: sourceCode, mp4: 'flac', video: 'h264' }).toString();
  } else if (sourceQuery) {
    target.search = sourceQuery;
  }

  const headers: Record<string, string> = {
    Accept: '*/*',
    Origin: TULUNGAGUNG_BASE.origin,
    Referer: `${TULUNGAGUNG_BASE.origin}/`,
    'User-Agent': USER_AGENT,
  };
  if (req.headers.range) headers.Range = String(req.headers.range);

  await proxyUpstream(
    res,
    target,
    headers,
    true,
    isTulungagungTarget,
    (body, source) => rewriteTulungagungPlaylist(body, source.href, sourceCode),
    { source: 'tulungagung', cameraId: sourceCode }
  );
}
