import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import {
  BOJONEGORO_MAP_PATH,
  BOJONEGORO_PAGE_URL,
  BOJONEGORO_SESSION_PATH,
  BOJONEGORO_STREAM_BASE,
  BOJONEGORO_USER_AGENT,
  BOJONEGORO_YEAR,
} from './config.js';
import { readOpaqueQuery, rememberOpaqueQuery } from './opaque-query.js';

import {
  sendCircuitResponse,
  sendDegradedList,
  sendStreamGatewayError,
  sendUpstreamStreamError,
} from './regional-hls.js';
import { seedListCache } from './list-snapshot.js';
import {
  noteUpstreamStatus,
  markOfflineCameras,
  noteStreamHealthy,
  noteStreamUnreachable,
  streamCooldown,
} from './stream-circuit.js';

const MAX_MAP_BYTES = 3 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAP_CACHE_TTL_MS = 5 * 60 * 1000;
const STATUS_CACHE_TTL_MS = 45 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const pageUrl = new URL(BOJONEGORO_PAGE_URL);
const streamBase = new URL(BOJONEGORO_STREAM_BASE.endsWith('/') ? BOJONEGORO_STREAM_BASE : `${BOJONEGORO_STREAM_BASE}/`);

interface BojonegoroCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: 'online' | 'offline' | 'unknown';
  source: 'bojonegoro';
  protocol: 'hls';
  streamUrl?: string;
  sourceCode: string;
}

interface CacheEntry {
  ts: number;
  cameras: BojonegoroCamera[];
}

let mapCache: CacheEntry | null = seedListCache<BojonegoroCamera>('bojonegoro');
let statusCache = new Map<string, { ts: number; online: boolean }>();
let sessionCookie = '';
let sessionUntil = 0;
let lastMapWasStale = false;

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readCookieHeader(headers: Headers): string {
  const value = headers.get('set-cookie') || '';
  return value
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((part) => part.split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
}

function mergeCookies(existing: string, incoming: string): string {
  const values = new Map<string, string>();
  for (const item of `${existing}; ${incoming}`.split(';')) {
    const trimmed = item.trim();
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return [...values.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

function requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: '*/*',
    'User-Agent': BOJONEGORO_USER_AGENT,
    Referer: pageUrl.href,
    ...extra,
  };
}

async function refreshSession(): Promise<string> {
  const pageResponse = await fetch(pageUrl, {
    headers: requestHeaders({ Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!pageResponse.ok) throw new Error(`Halaman Bojonegoro membalas HTTP ${pageResponse.status}.`);
  await pageResponse.text();
  let cookie = readCookieHeader(pageResponse.headers);

  const sessionPath = BOJONEGORO_SESSION_PATH.replace(/\{year\}/g, encodeURIComponent(BOJONEGORO_YEAR));
  const sessionUrl = new URL(sessionPath, pageUrl);
  const sessionResponse = await fetch(sessionUrl, {
    method: 'GET',
    headers: requestHeaders(cookie ? { Cookie: cookie } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!sessionResponse.ok) throw new Error(`Session Bojonegoro membalas HTTP ${sessionResponse.status}.`);
  await sessionResponse.text();
  cookie = mergeCookies(cookie, readCookieHeader(sessionResponse.headers));
  if (!cookie) throw new Error('Session publik Bojonegoro tidak menghasilkan cookie.');
  sessionCookie = cookie;
  sessionUntil = Date.now() + 8 * 60 * 1000;
  return cookie;
}

async function getSessionCookie(forceRefresh = false): Promise<string> {
  if (!forceRefresh && sessionCookie && sessionUntil > Date.now()) return sessionCookie;
  return refreshSession();
}

async function fetchText(path: string, cookie: string): Promise<string> {
  const url = new URL(path, pageUrl);
  if (url.origin !== pageUrl.origin) throw new Error('Path Bojonegoro di luar origin yang diizinkan.');
  const response = await fetch(url, {
    headers: requestHeaders(cookie ? { Cookie: cookie } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Metadata Bojonegoro membalas HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > MAX_MAP_BYTES) throw new Error('Metadata Bojonegoro terlalu besar.');
  return text;
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(['"\\])/g, '$1')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function streamIdFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const filename = url.pathname.split('/').pop() || '';
    const id = filename.replace(/\.m3u8$/i, '');
    return UUID_RE.test(id) ? id.toLowerCase() : '';
  } catch {
    return '';
  }
}

function parseMarkerName(chunk: string): string {
  const popup = chunk.match(/popUpViewScaffold\s*\(\s*['"]<p[^>]*>([\s\S]*?)<\/p>/i);
  if (popup?.[1]) return decodeHtmlText(popup[1]) || 'CCTV Bojonegoro';
  const tooltip = chunk.match(/bindTooltip\s*\(\s*['"]([\s\S]*?)['"]/i);
  return (tooltip?.[1] && decodeHtmlText(tooltip[1])) || 'CCTV Bojonegoro';
}

function parseBojonegoroMap(html: string): BojonegoroCamera[] {
  const chunks = html.split(/L\.marker\s*\(/).slice(1);
  const cameras: BojonegoroCamera[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const coordinates = chunk.match(/^\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/);
    if (!coordinates) continue;
    const latitude = Number(coordinates[1]);
    const longitude = Number(coordinates[2]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    const playMatch = chunk.match(/playHLS\s*\(\s*['"][^'"]+['"]\s*,\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/i);
    const streamId = playMatch?.[1] ? streamIdFromUrl(playMatch[1]) : '';
    if (streamId && seen.has(streamId)) continue;
    if (streamId) seen.add(streamId);

    const name = parseMarkerName(chunk);
    cameras.push({
      slug: `bojonegoro-${streamId || `marker-${cameras.length + 1}`}`,
      name,
      location: 'Kabupaten Bojonegoro',
      latitude,
      longitude,
      status: streamId ? 'online' : 'offline',
      source: 'bojonegoro',
      protocol: 'hls',
      sourceCode: streamId,
      ...(streamId
        ? {
            streamUrl: `/api/hls-proxy?${new URLSearchParams({
              source: 'bojonegoro',
              mode: 'hls',
              streamId,
              asset: `${streamId}.m3u8`,
            }).toString()}`,
          }
        : {}),
    });
  }

  return cameras;
}

async function probeStream(streamId: string, cookie: string): Promise<boolean> {
  const cached = statusCache.get(streamId);
  if (cached && Date.now() - cached.ts < STATUS_CACHE_TTL_MS) return cached.online;
  const target = new URL(`${streamId}.m3u8`, streamBase);
  if (target.origin !== streamBase.origin || !target.pathname.startsWith(streamBase.pathname)) return false;
  try {
    const response = await fetch(target, {
      headers: requestHeaders(cookie ? { Cookie: cookie } : {}),
      signal: AbortSignal.timeout(4500),
    });
    const online = response.ok && (response.headers.get('content-type') || '').toLowerCase().includes('mpegurl');
    response.body?.cancel().catch(() => undefined);
    statusCache.set(streamId, { ts: Date.now(), online });
    return online;
  } catch {
    statusCache.set(streamId, { ts: Date.now(), online: false });
    return false;
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

async function getBojonegoroCameras(forceRefresh = false, shouldProbe = false): Promise<BojonegoroCamera[]> {
  const now = Date.now();
  if (!forceRefresh && mapCache && now - mapCache.ts < MAP_CACHE_TTL_MS) return mapCache.cameras;

  try {
    let cookie = await getSessionCookie(forceRefresh);
    let html: string;
    try {
      html = await fetchText(BOJONEGORO_MAP_PATH, cookie);
    } catch (error) {
      if (!forceRefresh) {
        cookie = await getSessionCookie(true);
        html = await fetchText(BOJONEGORO_MAP_PATH, cookie);
      } else {
        throw error;
      }
    }
    const cameras = parseBojonegoroMap(html);
    if (cameras.length === 0) throw new Error('Metadata Bojonegoro tidak berisi marker kamera.');
    const streamIds = cameras.filter((camera) => camera.sourceCode).map((camera) => camera.sourceCode);
    const online = shouldProbe
      ? await mapWithConcurrency(streamIds, 8, (id) => probeStream(id, cookie))
      : [];
    const statusById = new Map(streamIds.map((id, index) => [id, online[index]]));
    const normalized = cameras.map((camera) => {
      const cached = camera.sourceCode ? statusCache.get(camera.sourceCode) : undefined;
      const hasRecentStatus = cached && Date.now() - cached.ts < STATUS_CACHE_TTL_MS;
      const status = hasRecentStatus
        ? (cached.online ? 'online' as const : 'offline' as const)
        : shouldProbe
          ? (statusById.get(camera.sourceCode || '') ? 'online' as const : 'offline' as const)
          : (camera.streamUrl ? 'unknown' as const : 'offline' as const);
      return { ...camera, status };
    });
    mapCache = { ts: now, cameras: normalized };
    lastMapWasStale = false;
    return normalized;
  } catch (error) {
    if (mapCache) {
      lastMapWasStale = true;
      return mapCache.cameras;
    }
    throw error;
  }
}

function safeAsset(asset: string): boolean {
  return Boolean(
    asset &&
    asset.length <= 512 &&
    /^[A-Za-z0-9._/-]+$/.test(asset) &&
    !asset.startsWith('/') &&
    !asset.includes('\\') &&
    !asset.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function isStreamTarget(target: URL): boolean {
  if (target.origin !== streamBase.origin) return false;
  const prefix = streamBase.pathname.endsWith('/') ? streamBase.pathname : `${streamBase.pathname}/`;
  return target.pathname.startsWith(prefix);
}

function proxyAssetUrl(streamId: string, asset: string, query: string): string {
  const params = new URLSearchParams({ source: 'bojonegoro', mode: 'hls', streamId, asset });
  if (query) params.set('queryId', rememberOpaqueQuery(`boj:${streamId}`, query.slice(0, 2048)));
  return `/api/hls-proxy?${params.toString()}`;
}

function rewritePlaylist(text: string, sourceUrl: URL, streamId: string): string {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/gi, (original, uri: string) => {
        try {
          const absolute = new URL(uri, sourceUrl);
          if (!isStreamTarget(absolute)) return original;
          const prefix = streamBase.pathname.endsWith('/') ? streamBase.pathname : `${streamBase.pathname}/`;
          const asset = absolute.pathname.slice(prefix.length);
          if (!safeAsset(asset)) return original;
          return `URI="${proxyAssetUrl(streamId, asset, absolute.search.slice(1))}"`;
        } catch {
          return original;
        }
      });
    }
    try {
      const absolute = new URL(trimmed, sourceUrl);
      if (!isStreamTarget(absolute)) return line;
      const prefix = streamBase.pathname.endsWith('/') ? streamBase.pathname : `${streamBase.pathname}/`;
      const asset = absolute.pathname.slice(prefix.length);
      return safeAsset(asset) ? proxyAssetUrl(streamId, asset, absolute.search.slice(1)) : line;
    } catch {
      return line;
    }
  }).join('\n');
}

async function readPlaylist(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_PLAYLIST_BYTES) throw new Error('Manifest Bojonegoro terlalu besar.');
  const text = await response.text();
  if (text.length > MAX_PLAYLIST_BYTES) throw new Error('Manifest Bojonegoro terlalu besar.');
  return text;
}

function pipeBinary(response: Response, res: ServerResponse): void {
  if (!response.body) {
    res.end();
    return;
  }
  const upstream = Readable.fromWeb(response.body as any);
  res.on('close', () => upstream.destroy());
  upstream.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders();
  upstream.pipe(res);
}

async function handleList(res: ServerResponse, forceRefresh: boolean, shouldProbe: boolean): Promise<void> {
  try {
    const cameras = await getBojonegoroCameras(forceRefresh, shouldProbe);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=600');
    res.setHeader('X-Lensamas-Data', lastMapWasStale ? 'stale' : 'fresh');
    res.end(JSON.stringify({ data: markOfflineCameras('bojonegoro', cameras), source: 'bojonegoro' }));
  } catch (error) {
    sendDegradedList(res, 'bojonegoro', mapCache?.cameras || [], (error as Error).message);
  }
}

async function handleHls(req: IncomingMessage, res: ServerResponse, requestUrl: URL): Promise<void> {
  const streamId = requestUrl.searchParams.get('streamId') || '';
  const asset = requestUrl.searchParams.get('asset') || `${streamId}.m3u8`;
  const queryId = requestUrl.searchParams.get('queryId');
  const sourceQuery = readOpaqueQuery(`boj:${streamId}`, queryId);
  if (!UUID_RE.test(streamId) || !safeAsset(asset) || (queryId && !sourceQuery)) {
    sendJson(res, 400, { error: 'Parameter stream Bojonegoro tidak valid.' });
    return;
  }
  const cooldown = streamCooldown('bojonegoro', streamId);
  if (cooldown) {
    sendCircuitResponse(res, cooldown, 'Stream Bojonegoro sedang tidak tersedia.');
    return;
  }

  const target = new URL(asset, streamBase);
  if (!isStreamTarget(target)) {
    sendJson(res, 400, { error: 'Target stream Bojonegoro tidak diizinkan.' });
    return;
  }
  if (sourceQuery) target.search = sourceQuery;

  let cookie = sessionCookie;
  if (!cookie) {
    try {
      cookie = await getSessionCookie();
    } catch (error) {
      noteStreamUnreachable('bojonegoro', streamId);
      sendStreamGatewayError(res, `Session stream Bojonegoro gagal: ${(error as Error).message}`);
      return;
    }
  }
  const headers = requestHeaders(cookie ? { Cookie: cookie } : {});
  if (req.headers.range) headers.Range = String(req.headers.range);

  let response: Response;
  try {
    response = await fetch(target, { headers, signal: AbortSignal.timeout(15_000) });
    if ((response.status === 401 || response.status === 403) && cookie) {
      await response.body?.cancel().catch(() => undefined);
      cookie = await getSessionCookie(true);
      response = await fetch(target, {
        headers: requestHeaders({ Cookie: cookie, ...(req.headers.range ? { Range: String(req.headers.range) } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
    }
  } catch (error) {
    noteStreamUnreachable('bojonegoro', streamId);
    sendStreamGatewayError(res, `Proxy stream Bojonegoro gagal: ${(error as Error).message}`);
    return;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    noteUpstreamStatus('bojonegorenepo', streamId, response.status);
    sendUpstreamStreamError(res, response.status, `Stream Bojonegoro membalas HTTP ${response.status}.`, {
      upstreamStatus: response.status,
    });
    return;
  }
  noteStreamHealthy('bojonegoro', streamId);

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (asset.toLowerCase().endsWith('.m3u8') || contentType.includes('mpegurl')) {
    try {
      const text = await readPlaylist(response);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.end(rewritePlaylist(text, target, streamId));
    } catch (error) {
      if (!res.headersSent) sendJson(res, 502, { error: (error as Error).message });
    }
    return;
  }

  res.statusCode = response.status;
  res.setHeader('Content-Type', response.headers.get('content-type') || 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  for (const header of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = response.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  pipeBinary(response, res);
}

export async function handleBojonegoro(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method tidak valid.' });
    return;
  }
  const requestUrl = new URL(req.url || '', 'http://localhost');
  const mode = requestUrl.searchParams.get('mode') || 'list';
  if (mode === 'list') {
    await handleList(
      res,
      requestUrl.searchParams.get('refresh') === '1',
      requestUrl.searchParams.get('probe') === '1'
    );
    return;
  }
  if (mode === 'hls') {
    await handleHls(req, res, requestUrl);
    return;
  }
  sendJson(res, 400, { error: 'Mode Bojonegoro tidak valid.' });
}
