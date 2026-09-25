import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  BANYUWANGI_BASE_URL,
  BANYUWANGI_PAGE_PATH,
  BANYUWANGI_STREAM_BASE,
  REGIONAL_CCTV_USER_AGENT,
} from './config.js';
import { redactLogMessage, shouldWriteProviderLog } from './request-log.js';
import {
  pipeRegionalBinary,
  readRegionalText,
  regionalHeaders,
  regionalTarget,
  rewriteRegionalPlaylist,
  safeRegionalAsset,
  sendRegionalJson,
  setRegionalGetCors,
  REGIONAL_MAX_PLAYLIST_BYTES,
  REGIONAL_REQUEST_TIMEOUT_MS,
} from './regional-hls.js';
import {
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
} from './stream-circuit.js';

const MAX_JSON_BYTES = 3 * 1024 * 1024;
const LIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CAMERA_RE = /^\d{1,6}$/;
const baseUrl = new URL(BANYUWANGI_BASE_URL.endsWith('/') ? BANYUWANGI_BASE_URL : `${BANYUWANGI_BASE_URL}/`);
const streamBase = new URL(BANYUWANGI_STREAM_BASE.endsWith('/') ? BANYUWANGI_STREAM_BASE : `${BANYUWANGI_STREAM_BASE}/`);
const streamPathPrefix = streamBase.pathname.endsWith('/') ? streamBase.pathname : `${streamBase.pathname}/`;

interface BanyuwangiCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: 'unknown';
  device_status: 'not_reported';
  source: 'banyuwangi';
  protocol: 'hls';
  streamUrl: string;
  sourceCode: string;
}

interface CacheEntry {
  ts: number;
  cameras: BanyuwangiCamera[];
}

interface WordPressPage {
  content?: { rendered?: unknown };
}

let listCache: CacheEntry | null = seedListCache<BanyuwangiCamera>('banyuwangi');
let lastListWasStale = false;
let listInFlight: Promise<BanyuwangiCamera[]> | null = null;

function logBanyuwangi(level: 'info' | 'error', payload: Record<string, unknown>): void {
  if (!shouldWriteProviderLog(level)) return;
  if (level === 'info' && payload.event === 'stream-response') return;
  const line = `[lensamas-banyuwangi] ${JSON.stringify({ source: 'banyuwangi', ...payload })}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function validCameraId(value: string): boolean {
  return CAMERA_RE.test(value);
}

function decodeJavaScriptString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, ' ')
      .trim();
  }
}

function proxyAssetUrl(cameraId: string, asset: string): string {
  return `/api/hls-proxy?${new URLSearchParams({
    source: 'banyuwangi',
    mode: 'hls',
    camera: cameraId,
    asset,
  }).toString()}`;
}

function parseCameraRows(content: string): BanyuwangiCamera[] {
  const block = content.match(/(?:var\s+)?cctvData\s*=\s*\[([\s\S]*?)\]\s*;/i);
  if (!block) throw new Error('Halaman Banyuwangi tidak memuat data cctvData.');

  const rowPattern = /\[\s*(\d+)\s*,\s*"((?:\\.|[^"\\])*)"\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*\]/g;
  const cameras: BanyuwangiCamera[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(block[1])) !== null) {
    const sourceCode = match[1];
    if (!validCameraId(sourceCode) || seen.has(sourceCode)) continue;
    const name = decodeJavaScriptString(match[2]).slice(0, 200);
    const latitude = Number(match[3]);
    const longitude = Number(match[4]);
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    seen.add(sourceCode);
    cameras.push({
      slug: `banyuwangi-${sourceCode}`,
      name,
      location: 'Kabupaten Banyuwangi',
      latitude,
      longitude,
      status: 'unknown',
      device_status: 'not_reported',
      source: 'banyuwangi',
      protocol: 'hls',
      streamUrl: proxyAssetUrl(sourceCode, 'playlist.m3u8'),
      sourceCode,
    });
  }
  if (cameras.length === 0) throw new Error('Data cctvData Banyuwangi tidak memuat kamera yang valid.');
  return cameras;
}

async function fetchPage(requestId: string): Promise<BanyuwangiCamera[]> {
  const target = regionalTarget(baseUrl, BANYUWANGI_PAGE_PATH, 'Banyuwangi');
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(target, {
      headers: regionalHeaders(REGIONAL_CCTV_USER_AGENT, { Accept: 'application/json' }),
      signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logBanyuwangi('error', {
      event: 'metadata-error',
      requestId,
      durationMs: Date.now() - startedAt,
      error: redactLogMessage((error as Error).message),
    });
    throw error;
  }
  logBanyuwangi('info', {
    event: 'metadata-response',
    requestId,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  if (!response.ok) throw new Error(`Halaman API Banyuwangi membalas HTTP ${response.status}.`);
  const text = await readRegionalText(response, MAX_JSON_BYTES, 'metadata Banyuwangi');
  let payload: WordPressPage | WordPressPage[];
  try {
    payload = JSON.parse(text) as WordPressPage | WordPressPage[];
  } catch {
    throw new Error('Respons API Banyuwangi bukan JSON yang valid.');
  }
  const page = Array.isArray(payload) ? payload[0] : payload;
  const content = page?.content?.rendered;
  if (typeof content !== 'string') throw new Error('Respons API Banyuwangi tidak berisi content.rendered.');
  return parseCameraRows(content);
}

async function getBanyuwangiCameras(
  forceRefresh = false,
  requestId = 'unknown'
): Promise<BanyuwangiCamera[]> {
  const now = Date.now();
  if (!forceRefresh && listCache && now - listCache.ts < LIST_CACHE_TTL_MS) return listCache.cameras;
  if (listInFlight) return listInFlight;

  listInFlight = fetchPage(requestId)
    .then((cameras) => {
      listCache = { ts: Date.now(), cameras };
      lastListWasStale = false;
      return cameras;
    })
    .catch((error) => {
      if (listCache) {
        lastListWasStale = true;
        return listCache.cameras;
      }
      throw error;
    })
    .finally(() => {
      listInFlight = null;
    });
  return listInFlight;
}

function isBanyuwangiTarget(target: URL, cameraId: string): boolean {
  return target.origin === streamBase.origin && target.pathname.startsWith(`${streamPathPrefix}${cameraId}/`);
}

async function handleHls(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  requestId: string
): Promise<void> {
  const cameraId = requestUrl.searchParams.get('camera') || '';
  const asset = requestUrl.searchParams.get('asset') || 'playlist.m3u8';
  if (!validCameraId(cameraId) || !safeRegionalAsset(asset) || !/\.(m3u8|ts)$/i.test(asset)) {
    sendRegionalJson(res, 400, { error: 'Parameter stream Banyuwangi tidak valid.' });
    return;
  }

  const target = regionalTarget(streamBase, `${cameraId}/${asset}`, 'Banyuwangi stream');
  if (!isBanyuwangiTarget(target, cameraId)) {
    sendRegionalJson(res, 400, { error: 'Target stream Banyuwangi tidak diizinkan.' });
    return;
  }
  const headers = regionalHeaders(REGIONAL_CCTV_USER_AGENT, { Accept: '*/*' });
  if (req.headers.range) headers.Range = String(req.headers.range);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(target, { headers, signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS) });
  } catch (error) {
    logBanyuwangi('error', {
      event: 'stream-error',
      requestId,
      camera: cameraId,
      asset,
      durationMs: Date.now() - startedAt,
      error: redactLogMessage((error as Error).message),
    });
    noteStreamUnreachable('banyuwangi', cameraId);
    sendStreamGatewayError(res, `Proxy stream Banyuwangi gagal: ${(error as Error).message}`);
    return;
  }
  logBanyuwangi('info', {
    event: 'stream-response',
    requestId,
    camera: cameraId,
    asset,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    noteUpstreamStatus('banyuwangi', cameraId, response.status);
    sendUpstreamStreamError(res, response.status, `Stream Banyuwangi membalas HTTP ${response.status}.`, {
      upstreamStatus: response.status,
    });
    return;
  }
  noteStreamHealthy('banyuwangi', cameraId);

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (asset.toLowerCase().endsWith('.m3u8') || contentType.includes('mpegurl')) {
    try {
      const text = await readRegionalText(response, REGIONAL_MAX_PLAYLIST_BYTES, 'manifest Banyuwangi');
      if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Manifest Banyuwangi tidak valid.');
      const rewritten = rewriteRegionalPlaylist(text, target, (absolute) => {
        if (!isBanyuwangiTarget(absolute, cameraId)) return null;
        const path = absolute.pathname.slice(`${streamPathPrefix}${cameraId}/`.length);
        const child = path.split('/').pop() || '';
        return safeRegionalAsset(child) ? proxyAssetUrl(cameraId, child) : null;
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.end(rewritten);
    } catch (error) {
      if (!res.headersSent) sendRegionalJson(res, 502, { error: (error as Error).message });
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

export async function handleBanyuwangi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setRegionalGetCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendRegionalJson(res, 405, { error: 'Method Banyuwangi tidak valid.' });
    return;
  }
  const requestUrl = new URL(req.url || '', 'http://localhost');
  const mode = requestUrl.searchParams.get('mode') || 'list';
  const requestId = String(res.getHeader('X-Request-Id') || 'unknown');
  if (mode === 'list') {
    try {
      const cameras = await getBanyuwangiCameras(requestUrl.searchParams.get('refresh') === '1', requestId);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=1800, stale-while-revalidate=21600');
      res.setHeader('X-Lensamas-Data', lastListWasStale ? 'stale' : 'fresh');
      res.setHeader('X-Lensamas-Stale', lastListWasStale ? '1' : '0');
      res.end(JSON.stringify({ data: markOfflineCameras('banyuwangi', cameras), source: 'banyuwangi' }));
    } catch (error) {
      sendDegradedList(res, 'banyuwangi', listCache?.cameras || [], (error as Error).message);
    }
    return;
  }
  if (mode === 'hls') {
    await handleHls(req, res, requestUrl, requestId);
    return;
  }
  sendRegionalJson(res, 400, { error: 'Mode Banyuwangi tidak valid.' });
}
