import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import {
  TUBAN_BASE_URL,
  TUBAN_GEOMETRIES_PATH,
  TUBAN_STREAM_TOKEN_PATH,
  TUBAN_TOKEN_TTL_SECONDS,
  TUBAN_USER_AGENT,
} from './config.js';
import { redactLogMessage, shouldWriteProviderLog } from './request-log.js';
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

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const LIST_CACHE_TTL_MS = 60_000;
const CAMERA_RE = /^\d{1,10}$/;
const ASSET_RE = /^[A-Za-z0-9._-]{1,256}$/;
const baseUrl = new URL(TUBAN_BASE_URL.endsWith('/') ? TUBAN_BASE_URL : `${TUBAN_BASE_URL}/`);
const tokenTtlMs = Math.max(30, Number(TUBAN_TOKEN_TTL_SECONDS) || 120) * 1000;

interface TubanCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: 'online' | 'offline';
  device_status?: string;
  source: 'tuban';
  protocol: 'hls';
  streamUrl?: string;
  sourceCode: string;
}

interface CacheEntry {
  ts: number;
  cameras: TubanCamera[];
}

interface TokenEntry {
  url: string;
  expiresAt: number;
}

let listCache: CacheEntry | null = seedListCache<TubanCamera>('tuban');
let lastListWasStale = false;
let listInFlight: Promise<TubanCamera[]> | null = null;
const tokenCache = new Map<string, TokenEntry>();
const tokenInFlight = new Map<string, Promise<string>>();

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Lensamas-Source');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function logTuban(level: 'info' | 'error', payload: Record<string, unknown>): void {
  if (!shouldWriteProviderLog(level)) return;
  if (level === 'info' && payload.event === 'stream-response') return;
  const line = `[lensamas-tuban] ${JSON.stringify({ source: 'tuban', ...payload })}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': TUBAN_USER_AGENT,
    ...extra,
  };
}

function targetUrl(path: string): URL {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) throw new Error('Path Tuban di luar origin yang diizinkan.');
  return url;
}

function validCameraId(value: string): boolean {
  return CAMERA_RE.test(value);
}

function safeAsset(value: string): boolean {
  return ASSET_RE.test(value) && !value.includes('..');
}

function parseCamera(value: unknown): TubanCamera | null {
  if (!value || typeof value !== 'object') return null;
  const feature = value as {
    id?: unknown;
    geometry?: { coordinates?: unknown };
    properties?: Record<string, unknown>;
  };
  const properties = feature.properties || {};
  const idValue = properties.id ?? feature.id;
  const id = typeof idValue === 'number' ? String(idValue) : String(idValue ?? '').trim();
  if (!validCameraId(id)) return null;

  const coordinates = Array.isArray(feature.geometry?.coordinates) ? feature.geometry.coordinates : [];
  const latitude = Number(properties.lat ?? coordinates[1]);
  const longitude = Number(properties.lng ?? coordinates[0]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  const name = typeof properties.name === 'string' && properties.name.trim()
    ? properties.name.trim()
    : `CCTV Tuban ${id}`;
  const locationParts = [
    typeof properties.lokasi === 'string' ? properties.lokasi.trim() : '',
    typeof properties.desa === 'string' ? `Desa/Kel. ${properties.desa.trim()}` : '',
    typeof properties.kecamatan === 'string' ? `Kec. ${properties.kecamatan.trim()}` : '',
  ].filter(Boolean);
  const location = locationParts.join(' · ') || 'Kabupaten Tuban';
  const deviceStatus = typeof properties.status === 'string' ? properties.status.trim() : '';
  const status = deviceStatus.toLowerCase() === 'aktif' ? 'online' : 'offline';
  const hasStream = typeof properties.stream_url === 'string' && properties.stream_url.trim().length > 0;

  return {
    slug: `tuban-${id}`,
    name,
    location,
    latitude,
    longitude,
    status,
    ...(deviceStatus ? { device_status: deviceStatus } : {}),
    source: 'tuban',
    protocol: 'hls',
    sourceCode: id,
    ...(hasStream
      ? {
          streamUrl: `/api/hls-proxy?${new URLSearchParams({
            source: 'tuban',
            mode: 'hls',
            camera: id,
            asset: 'index.m3u8',
          }).toString()}`,
        }
      : {}),
  };
}

async function fetchGeometries(requestId: string): Promise<TubanCamera[]> {
  const target = targetUrl(TUBAN_GEOMETRIES_PATH);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(target, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logTuban('error', {
      event: 'metadata-error',
      requestId,
      durationMs: Date.now() - startedAt,
      error: redactLogMessage((error as Error).message),
    });
    throw error;
  }
  logTuban('info', {
    event: 'metadata-response',
    requestId,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  if (!response.ok) throw new Error(`API geometri Tuban membalas HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > MAX_JSON_BYTES) throw new Error('Respons geometri Tuban terlalu besar.');
  let payload: { features?: unknown };
  try {
    payload = JSON.parse(text) as { features?: unknown };
  } catch {
    throw new Error('Respons geometri Tuban bukan JSON yang valid.');
  }
  if (!Array.isArray(payload.features)) throw new Error('Respons geometri Tuban tidak berisi features.');
  const cameras: TubanCamera[] = [];
  const seen = new Set<string>();
  for (const feature of payload.features) {
    const camera = parseCamera(feature);
    if (!camera || seen.has(camera.sourceCode)) continue;
    seen.add(camera.sourceCode);
    cameras.push(camera);
  }
  if (cameras.length === 0) throw new Error('Metadata Tuban tidak memuat kamera yang valid.');
  return cameras;
}

async function getTubanCameras(forceRefresh = false, requestId = 'unknown'): Promise<TubanCamera[]> {
  const now = Date.now();
  if (!forceRefresh && listCache && now - listCache.ts < LIST_CACHE_TTL_MS) return listCache.cameras;
  if (listInFlight) return listInFlight;

  listInFlight = fetchGeometries(requestId)
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

async function getStreamToken(cameraId: string, requestId: string, forceRefresh = false): Promise<string> {
  const cached = tokenCache.get(cameraId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.url;
  const inFlight = tokenInFlight.get(cameraId);
  if (inFlight) return inFlight;

  const task = (async (): Promise<string> => {
    const target = targetUrl(`${TUBAN_STREAM_TOKEN_PATH.replace(/\/+$/, '')}/${encodeURIComponent(cameraId)}`);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(target, {
        headers: requestHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      logTuban('error', {
        event: 'token-error',
        requestId,
        camera: cameraId,
        durationMs: Date.now() - startedAt,
        error: redactLogMessage((error as Error).message),
      });
      throw error;
    }
    logTuban('info', {
      event: 'token-response',
      requestId,
      camera: cameraId,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    if (!response.ok) throw new Error(`Token stream Tuban membalas HTTP ${response.status}.`);
    const payload = await response.json() as { stream_url?: unknown };
    if (typeof payload.stream_url !== 'string') throw new Error('Token stream Tuban tidak memiliki stream_url.');
    let streamUrl: URL;
    try {
      streamUrl = new URL(payload.stream_url);
    } catch {
      throw new Error('URL stream Tuban tidak valid.');
    }
    const prefix = `/hls-proxy/cam${cameraId}/`;
    if (streamUrl.origin !== baseUrl.origin || !streamUrl.pathname.startsWith(prefix)) {
      throw new Error('URL stream Tuban di luar host/path yang diizinkan.');
    }
    tokenCache.set(cameraId, { url: streamUrl.href, expiresAt: Date.now() + tokenTtlMs });
    return streamUrl.href;
  })().finally(() => tokenInFlight.delete(cameraId));
  tokenInFlight.set(cameraId, task);
  return task;
}

function isTubanTarget(target: URL, cameraId: string): boolean {
  return target.origin === baseUrl.origin && target.pathname.startsWith(`/hls-proxy/cam${cameraId}/`);
}

function proxyAssetUrl(cameraId: string, asset: string): string {
  return `/api/hls-proxy?${new URLSearchParams({
    source: 'tuban',
    mode: 'hls',
    camera: cameraId,
    asset,
  }).toString()}`;
}

function rewritePlaylist(text: string, sourceUrl: URL, cameraId: string): string {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/gi, (original, uri: string) => {
        try {
          const absolute = new URL(uri, sourceUrl);
          if (!isTubanTarget(absolute, cameraId)) return original;
          const asset = absolute.pathname.split('/').pop() || '';
          return safeAsset(asset) ? `URI="${proxyAssetUrl(cameraId, asset)}"` : original;
        } catch {
          return original;
        }
      });
    }
    try {
      const absolute = new URL(trimmed, sourceUrl);
      if (!isTubanTarget(absolute, cameraId)) return line;
      const asset = absolute.pathname.split('/').pop() || '';
      return safeAsset(asset) ? proxyAssetUrl(cameraId, asset) : line;
    } catch {
      return line;
    }
  }).join('\n');
}

async function readPlaylist(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > MAX_PLAYLIST_BYTES) throw new Error('Manifest Tuban terlalu besar.');
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
  upstream.pipe(res);
}

async function handleHls(req: IncomingMessage, res: ServerResponse, requestUrl: URL, requestId: string): Promise<void> {
  const cameraId = requestUrl.searchParams.get('camera') || '';
  const asset = requestUrl.searchParams.get('asset') || 'index.m3u8';
  if (!validCameraId(cameraId) || !safeAsset(asset)) {
    sendJson(res, 400, { error: 'Parameter stream Tuban tidak valid.' });
    return;
  }
  const cooldown = streamCooldown('tuban', cameraId);
  if (cooldown) {
    sendCircuitResponse(res, cooldown, 'Stream Tuban sedang tidak tersedia.');
    return;
  }

  let tokenUrl: URL;
  let target: URL;
  try {
    tokenUrl = new URL(await getStreamToken(cameraId, requestId));
    target = new URL(asset, tokenUrl);
    target.search = tokenUrl.search;
  } catch (error) {
    logTuban('error', {
      event: 'stream-token-error',
      requestId,
      camera: cameraId,
      asset,
      error: redactLogMessage((error as Error).message),
    });
    noteStreamUnreachable('tuban', cameraId);
    sendStreamGatewayError(res, `Token stream Tuban gagal: ${(error as Error).message}`);
    return;
  }
  if (!isTubanTarget(target, cameraId)) {
    sendJson(res, 400, { error: 'Target stream Tuban tidak diizinkan.' });
    return;
  }
  const headers = requestHeaders({ Accept: '*/*' });
  if (req.headers.range) headers.Range = String(req.headers.range);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(target, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if ((response.status === 401 || response.status === 403) && tokenCache.get(cameraId)) {
      await response.body?.cancel().catch(() => undefined);
      tokenUrl = new URL(await getStreamToken(cameraId, requestId, true));
      target = new URL(asset, tokenUrl);
      target.search = tokenUrl.search;
      response = await fetch(target, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    }
  } catch (error) {
    logTuban('error', {
      event: 'stream-error',
      requestId,
      camera: cameraId,
      asset,
      durationMs: Date.now() - startedAt,
      error: redactLogMessage((error as Error).message),
    });
    noteStreamUnreachable('tuban', cameraId);
    sendStreamGatewayError(res, `Proxy stream Tuban gagal: ${(error as Error).message}`);
    return;
  }
  logTuban('info', {
    event: 'stream-response',
    requestId,
    camera: cameraId,
    asset,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    noteUpstreamStatus('tuban', cameraId, response.status);
    sendUpstreamStreamError(res, response.status, `Stream Tuban membalas HTTP ${response.status}.`, {
      upstreamStatus: response.status,
    });
    return;
  }
  noteStreamHealthy('tuban', cameraId);

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (asset.toLowerCase().endsWith('.m3u8') || contentType.includes('mpegurl')) {
    try {
      const text = await readPlaylist(response);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.end(rewritePlaylist(text, target, cameraId));
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

export async function handleTuban(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method Tuban tidak valid.' });
    return;
  }
  const requestUrl = new URL(req.url || '', 'http://localhost');
  const mode = requestUrl.searchParams.get('mode') || 'list';
  const requestId = String(res.getHeader('X-Request-Id') || 'unknown');
  if (mode === 'list') {
    try {
      const cameras = await getTubanCameras(requestUrl.searchParams.get('refresh') === '1', requestId);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
      res.setHeader('X-Lensamas-Data', lastListWasStale ? 'stale' : 'fresh');
      res.setHeader('X-Lensamas-Stale', lastListWasStale ? '1' : '0');
      res.end(JSON.stringify({ data: markOfflineCameras('tuban', cameras), source: 'tuban' }));
    } catch (error) {
      sendDegradedList(res, 'tuban', listCache?.cameras || [], (error as Error).message);
    }
    return;
  }
  if (mode === 'hls') {
    await handleHls(req, res, requestUrl, requestId);
    return;
  }
  sendJson(res, 400, { error: 'Mode Tuban tidak valid.' });
}
