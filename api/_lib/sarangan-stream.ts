import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  SARANGAN_ALLOWED_HOSTS,
  httpsStream,
  resolveSaranganStreamUrl,
  toProxyUrl,
} from './sarangan.js';

const PLAYLIST_PATH_RE = /\.m3u8(\?|$)/i;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const CAMERA_RE = /^\d{1,5}\/[A-Za-z0-9_-]+$/;
const ASSET_RE = /^[A-Za-z0-9._~/%-]+$/;

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
}

function safeAsset(value: string): boolean {
  return Boolean(value) && ASSET_RE.test(value) && !value.includes('..') && !value.includes('\\');
}

function streamRoot(pathname: string): string {
  const slash = pathname.lastIndexOf('/');
  return slash >= 0 ? pathname.slice(0, slash + 1) : '/';
}

function rewritePlaylist(text: string, baseUrl: URL, camera: string): string {
  const rootPath = streamRoot(baseUrl.pathname);
  const proxyFor = (value: string): string | null => {
    try {
      const absolute = new URL(value, baseUrl);
      if (absolute.origin !== baseUrl.origin || !absolute.pathname.startsWith(rootPath)) return null;
      const asset = absolute.pathname.slice(rootPath.length);
      return safeAsset(asset) ? toProxyUrl(camera, asset) : null;
    } catch {
      return null;
    }
  };

  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/gi, (original, uri: string) => {
        const proxied = proxyFor(uri);
        return proxied ? `URI="${proxied}"` : original;
      });
    }
    return proxyFor(trimmed) || line;
  }).join('\n');
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
}

async function readPlaylist(stream: NodeJS.ReadableStream): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_PLAYLIST_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Proxy HLS Magetan dengan identifier kamera opaque. URL upstream, cookie,
 * dan query token tetap server-side; browser hanya menerima URL same-origin.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  const requestUrl = new URL(req.url || '', 'http://localhost');
  const camera = requestUrl.searchParams.get('camera') || '';
  const asset = requestUrl.searchParams.get('asset') || '';
  if (!CAMERA_RE.test(camera) || (asset && !safeAsset(asset))) {
    sendError(res, 400, 'Parameter stream Magetan tidak valid.');
    return;
  }

  let streamTarget: string | undefined;
  try {
    streamTarget = await resolveSaranganStreamUrl(camera);
  } catch {
    sendError(res, 502, 'Metadata stream Magetan tidak dapat dimuat.');
    return;
  }
  if (!streamTarget) {
    sendError(res, 404, 'Kamera Magetan tidak ditemukan.');
    return;
  }

  let base: URL;
  try {
    base = new URL(streamTarget);
  } catch {
    sendError(res, 502, 'Target stream Magetan tidak valid.');
    return;
  }
  if (base.protocol !== 'https:' || !SARANGAN_ALLOWED_HOSTS.has(base.hostname)) {
    sendError(res, 403, 'Host stream Magetan tidak diizinkan.');
    return;
  }

  const rootPath = streamRoot(base.pathname);
  const requestedAsset = asset || base.pathname.slice(rootPath.length) || 'file.m3u8';
  if (!safeAsset(requestedAsset)) {
    sendError(res, 400, 'Asset stream Magetan tidak valid.');
    return;
  }
  const target = new URL(requestedAsset, base);
  target.search = base.search;
  if (target.origin !== base.origin || !target.pathname.startsWith(rootPath)) {
    sendError(res, 400, 'Target stream Magetan tidak diizinkan.');
    return;
  }

  const range = req.headers.range ? String(req.headers.range) : undefined;
  try {
    const upstream = await httpsStream(target.href, 15000, range ? { Range: range } : {});
    const clientClosed = (): void => {
      try {
        upstream.stream.destroy();
      } catch {
        // noop
      }
    };
    res.on('close', clientClosed);

    if (upstream.status >= 400) {
      sendError(res, 502, `Sumber stream Magetan membalas HTTP ${upstream.status}.`);
      upstream.stream.destroy();
      return;
    }

    const contentType = String(upstream.headers['content-type'] || '');
    const isPlaylist = PLAYLIST_PATH_RE.test(target.pathname) || /mpegurl/i.test(contentType);
    if (isPlaylist) {
      const text = await readPlaylist(upstream.stream);
      if (text === null) {
        upstream.stream.destroy();
        if (!res.headersSent) sendError(res, 502, 'Manifest Magetan terlalu besar.');
        return;
      }
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.statusCode = 200;
      res.end(rewritePlaylist(text, target, camera));
      return;
    }

    res.setHeader('Content-Type', contentType || 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    for (const header of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = upstream.headers[header];
      if (value) res.setHeader(header, value);
    }
    res.statusCode = 200;
    res.socket?.setNoDelay(true);
    res.flushHeaders();
    upstream.stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    upstream.stream.pipe(res);
  } catch {
    if (!res.headersSent) {
      sendError(res, 502, 'Gagal meneruskan stream Magetan.');
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}
