import type { IncomingMessage, ServerResponse } from 'node:http';

import { KEDIRI_CAMERAS, KEDIRI_STREAM_BASE } from './config.js';
import {
  pipeRegionalBinary,
  readRegionalText,
  regionalHeaders,
  rewriteRegionalPlaylist,
  sendRegionalJson,
  setRegionalGetCors,
  REGIONAL_MAX_PLAYLIST_BYTES,
  REGIONAL_REQUEST_TIMEOUT_MS,
} from './regional-hls.js';
import { sendUpstreamStreamError } from './regional-hls.js';
import { markOfflineCameras, noteUpstreamStatus } from './stream-circuit.js';

const BASE_URL = new URL(KEDIRI_STREAM_BASE.endsWith('/') ? KEDIRI_STREAM_BASE : `${KEDIRI_STREAM_BASE}/`);
const CAMERA_RE = /^[a-z0-9_-]{1,80}$/;
const ASSET_RE = /^[A-Za-z0-9._~/%-]+$/;
const CAMERA_CODES = new Set(KEDIRI_CAMERAS.map((camera) => String(camera.sourceCode)));

function safeAsset(value: string): boolean {
  return Boolean(value) && ASSET_RE.test(value) && !value.includes('..') && !value.includes('\\');
}

function streamRoot(camera: string): string {
  return `/${camera}/`;
}

function proxyAssetUrl(camera: string, asset: string): string {
  return `/api/hls-proxy?${new URLSearchParams({
    source: 'kediri',
    mode: 'hls',
    camera,
    asset,
  }).toString()}`;
}

function rewritePlaylist(text: string, sourceUrl: URL, camera: string): string {
  const root = streamRoot(camera);
  return rewriteRegionalPlaylist(text, sourceUrl, (absolute) => {
    if (absolute.origin !== sourceUrl.origin || !absolute.pathname.startsWith(root)) return null;
    const asset = absolute.pathname.slice(root.length);
    return safeAsset(asset) ? proxyAssetUrl(camera, asset) : null;
  });
}

export async function handleKediriHls(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl = new URL(req.url || '', 'http://localhost')
): Promise<void> {
  setRegionalGetCors(res);
  const camera = requestUrl.searchParams.get('camera') || '';
  const asset = requestUrl.searchParams.get('asset') || 'index.m3u8';
  if (!CAMERA_RE.test(camera) || !CAMERA_CODES.has(camera) || !safeAsset(asset)) {
    sendRegionalJson(res, 400, { error: 'Parameter stream Kediri tidak valid.' });
    return;
  }

  if (BASE_URL.protocol !== 'https:' || BASE_URL.hostname !== 'pplterpadu.kedirikota.go.id' || BASE_URL.port !== '8888') {
    sendRegionalJson(res, 500, { error: 'Konfigurasi stream Kediri tidak valid.' });
    return;
  }
  const target = new URL(`${encodeURIComponent(camera)}/${asset}`, BASE_URL);
  if (target.origin !== BASE_URL.origin || !target.pathname.startsWith(streamRoot(camera))) {
    sendRegionalJson(res, 400, { error: 'Target stream Kediri tidak diizinkan.' });
    return;
  }

  const headers = regionalHeaders('lensamas-proxy/1.0', { Accept: '*/*' });
  if (req.headers.range) headers.Range = String(req.headers.range);
  let response: Response;
  try {
    response = await fetch(target, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
    });
  } catch {
    sendRegionalJson(res, 502, { error: 'Proxy stream Kediri gagal.' });
    return;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    noteUpstreamStatus('kediri', camera, response.status);
    sendUpstreamStreamError(res, response.status, `Stream Kediri membalas HTTP ${response.status}.`, {
      upstreamStatus: response.status,
    });
    return;
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (asset.toLowerCase().endsWith('.m3u8') || contentType.includes('mpegurl')) {
    try {
      const text = await readRegionalText(response, REGIONAL_MAX_PLAYLIST_BYTES, 'manifest Kediri');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.end(rewritePlaylist(text, target, camera));
    } catch {
      if (!res.headersSent) sendRegionalJson(res, 502, { error: 'Manifest Kediri tidak dapat diproses.' });
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
  pipeRegionalBinary(response, res);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setRegionalGetCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendRegionalJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }
  const requestUrl = new URL(req.url || '', 'http://localhost');
  const mode = requestUrl.searchParams.get('mode') || 'list';
  if (mode === 'hls') {
    await handleKediriHls(req, res, requestUrl);
    return;
  }
  if (mode !== 'list') {
    sendRegionalJson(res, 400, { error: 'Mode Kediri tidak valid.' });
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=1800, stale-while-revalidate=86400');
  res.end(JSON.stringify({ data: markOfflineCameras('kediri', KEDIRI_CAMERAS), source: 'kediri' }));
}
