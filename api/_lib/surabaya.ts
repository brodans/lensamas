import type { IncomingMessage, ServerResponse } from 'node:http';
import * as http from 'node:http';
import * as https from 'node:https';

import {
  APP_ORIGIN,
  SURABAYA_BASE_URL,
  SURABAYA_HLS_PATH,
  SURABAYA_LIST_PATH,
  SURABAYA_START_PATH,
  SURABAYA_STATUS_PATH,
  SURABAYA_STOP_PATH,
} from './config.js';

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

const CAMERA_RE = /^cctv_[0-9]{1,10}$/;
const ASSET_RE = /^stream(?:\.m3u8|[0-9]+\.ts)$/i;
const MAX_JSON_BYTES = 3 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const STATUS_CACHE_TTL_MS = 45 * 1000;
const USER_AGENT = 'lensamas-proxy/1.0';

const baseUrl = SURABAYA_BASE_URL
  ? new URL(SURABAYA_BASE_URL.endsWith('/') ? SURABAYA_BASE_URL : `${SURABAYA_BASE_URL}/`)
  : null;
if (baseUrl && baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
  throw new Error('SURABAYA_BASE_URL harus menggunakan http:// atau https://.');
}

interface SurabayaCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: 'online' | 'offline';
  source: 'surabaya';
  protocol: 'hls';
  streamUrl: string;
  sourceCode: string;
  channel?: number;
}

interface RawSurabayaCamera {
  id?: unknown;
  db_id?: unknown;
  name?: unknown;
  area?: unknown;
  lat?: unknown;
  lng?: unknown;
}

interface CacheEntry {
  ts: number;
  cameras: SurabayaCamera[];
}

let listCache: CacheEntry | null = seedListCache<SurabayaCamera>('surabaya');
let listInFlight: Promise<SurabayaCamera[]> | null = null;
let statusCache: { ts: number; values: Record<string, string> } | null = null;
let lastListWasFallback = false;
const controlWindows = new Map<string, { startedAt: number; count: number }>();

function controlRequestKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (value || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function isControlRateLimited(req: IncomingMessage): boolean {
  const now = Date.now();
  const key = controlRequestKey(req);
  const current = controlWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    if (controlWindows.size >= 2048) {
      const oldest = controlWindows.keys().next().value;
      if (oldest) controlWindows.delete(oldest);
    }
    controlWindows.set(key, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > 30;
}

function setCors(res: ServerResponse, req?: IncomingMessage): void {
  const isControl = req?.method === 'POST';
  if (!isControl || !req || isAllowedControlOrigin(req)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    res.removeHeader('Access-Control-Allow-Origin');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function isAllowedControlOrigin(req: IncomingMessage): boolean {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const host = typeof req.headers.host === 'string' ? req.headers.host : '';
    if (host && originUrl.host === host) return true;
    if (APP_ORIGIN && origin === new URL(APP_ORIGIN).origin) return true;
  } catch {
    return false;
  }
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(response: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else if (value) resolve(value);
    };
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy();
        finish(new Error('Respons upstream terlalu besar.'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => finish(undefined, Buffer.concat(chunks)));
    response.on('aborted', () => finish(new Error('Respons upstream terputus.')));
    response.on('error', (error) => finish(error));
  });
}

function requestUpstream(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  extraHeaders: Record<string, string> = {}
): Promise<http.IncomingMessage> {
  if (!baseUrl) {
    return Promise.reject(new Error('SURABAYA_BASE_URL belum dikonfigurasi di environment.'));
  }
  const target = new URL(path.replace(/^\/+/, ''), baseUrl);
  if (target.origin !== baseUrl.origin) {
    return Promise.reject(new Error('Target upstream Surabaya di luar origin yang diizinkan.'));
  }

  return new Promise((resolve, reject) => {
    const requestOptions: http.RequestOptions = {
      method,
      headers: {
        Accept: '*/*',
        'User-Agent': USER_AGENT,
        Connection: 'close',
        ...extraHeaders,
      },
    };
    const request = baseUrl.protocol === 'https:'
      ? https.request(target, requestOptions, (response) => resolve(response))
      : http.request(target, requestOptions, (response) => resolve(response));
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('Permintaan ke CCTV Surabaya habis waktu.'));
    });
    request.on('error', reject);
    request.end();
  });
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await requestUpstream(path);
  if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
    response.resume();
    throw new Error(`CCTV Surabaya membalas HTTP ${response.statusCode || 0}.`);
  }
  const body = await readBody(response, MAX_JSON_BYTES);
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new Error('Respons CCTV Surabaya bukan JSON yang valid.');
  }
}

function validCameraId(value: unknown): value is string {
  return typeof value === 'string' && CAMERA_RE.test(value);
}

function normalizeStatus(value: unknown): 'online' | 'offline' {
  const text = String(value ?? '').trim().toLowerCase();
  return ['online', 'active', '1', 'true', 'up'].includes(text) ? 'online' : 'offline';
}

function normalizeCamera(
  raw: RawSurabayaCamera,
  statuses: Record<string, string>
): SurabayaCamera | null {
  if (!validCameraId(raw.id)) return null;
  const latitude = Number(raw.lat);
  const longitude = Number(raw.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : raw.id;
  const area = typeof raw.area === 'string' && raw.area.trim() ? raw.area.trim() : 'Kota Surabaya';
  const channel = Number(raw.db_id);
  return {
    slug: `surabaya-${raw.id}`,
    name,
    location: area,
    latitude,
    longitude,
    status: normalizeStatus(statuses[raw.id]),
    source: 'surabaya',
    protocol: 'hls',
    streamUrl: `/api/hls-proxy?source=surabaya&mode=hls&camera=${encodeURIComponent(raw.id)}&asset=stream.m3u8`,
    sourceCode: raw.id,
    channel: Number.isFinite(channel) ? channel : undefined,
  };
}

function normalizeSurabayaCameras(
  raw: unknown,
  statuses: Record<string, string> = {}
): SurabayaCamera[] {
  if (!Array.isArray(raw)) return [];
  const out: SurabayaCamera[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const camera = normalizeCamera(item as RawSurabayaCamera, statuses);
    if (!camera || seen.has(camera.sourceCode)) continue;
    seen.add(camera.sourceCode);
    out.push(camera);
  }
  return out;
}

async function loadSurabayaCameras(forceRefresh = false): Promise<SurabayaCamera[]> {
  const now = Date.now();
  if (!forceRefresh && listCache && now - listCache.ts < LIST_CACHE_TTL_MS) {
    return listCache.cameras;
  }

  try {
    const [rawResult, statusResult] = await Promise.allSettled([
      fetchJson(SURABAYA_LIST_PATH),
      statusCache && now - statusCache.ts < STATUS_CACHE_TTL_MS
        ? Promise.resolve(statusCache.values)
        : fetchJson(SURABAYA_STATUS_PATH),
    ]);
    if (rawResult.status !== 'fulfilled') throw rawResult.reason;
    const statuses = statusResult.status === 'fulfilled' && statusResult.value &&
      typeof statusResult.value === 'object' && !Array.isArray(statusResult.value)
      ? statusResult.value as Record<string, string>
      : {};
    if (statusResult.status === 'fulfilled') statusCache = { ts: now, values: statuses };

    const cameras = normalizeSurabayaCameras(rawResult.value, statuses);
    if (cameras.length === 0) throw new Error('Tidak ada kamera Surabaya yang valid.');
    listCache = { ts: now, cameras };
    lastListWasFallback = false;
    return cameras;
  } catch (error) {
    if (listCache) {
      lastListWasFallback = true;
      listCache = { ts: now, cameras: listCache.cameras };
      return listCache.cameras;
    }
    throw error;
  }
}

function getSurabayaCameras(forceRefresh = false): Promise<SurabayaCamera[]> {
  const now = Date.now();
  if (!forceRefresh && listCache && now - listCache.ts < LIST_CACHE_TTL_MS) {
    return Promise.resolve(listCache.cameras);
  }
  if (listInFlight) return listInFlight;
  listInFlight = loadSurabayaCameras(forceRefresh).finally(() => {
    listInFlight = null;
  });
  return listInFlight;
}

async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req as http.IncomingMessage, 8 * 1024);
  if (body.length === 0) return {};
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function postAction(action: 'start' | 'stop', cameraId: string): Promise<unknown> {
  const path = `${action === 'start' ? SURABAYA_START_PATH : SURABAYA_STOP_PATH}/${encodeURIComponent(cameraId)}`;
  const response = await requestUpstream(path, 'POST', { 'Content-Length': '0' });
  const body = await readBody(response, 64 * 1024);
  if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
    throw new Error(`Aksi ${action} Surabaya membalas HTTP ${response.statusCode || 0}.`);
  }
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return { status: 'ok' };
  }
}

function proxyAssetUrl(cameraId: string, asset: string): string {
  const params = new URLSearchParams({
    source: 'surabaya',
    mode: 'hls',
    camera: cameraId,
    asset,
  });
  return `/api/hls-proxy?${params.toString()}`;
}

function rewriteSurabayaPlaylist(text: string, cameraId: string): string {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const asset = trimmed.split('/').pop() || '';
    if (!ASSET_RE.test(asset)) return line;
    return proxyAssetUrl(cameraId, asset);
  }).join('\n');
}

async function handleList(res: ServerResponse, forceRefresh: boolean): Promise<void> {
  try {
    const cameras = await getSurabayaCameras(forceRefresh);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=600');
    res.setHeader('X-Lensamas-Data', lastListWasFallback ? 'stale' : 'fresh');
    res.end(JSON.stringify({ data: markOfflineCameras('surabaya', cameras), source: 'surabaya' }));
  } catch (error) {
    sendDegradedList(res, 'surabaya', listCache?.cameras || [], (error as Error).message);
  }
}

async function handleAction(
  req: IncomingMessage,
  res: ServerResponse,
  action: 'start' | 'stop'
): Promise<void> {
  const requestUrl = new URL(req.url || '', 'http://localhost');
  if (!isAllowedControlOrigin(req)) {
    sendJson(res, 403, { error: 'Origin kontrol stream tidak diizinkan.' });
    return;
  }
  if (isControlRateLimited(req)) {
    sendJson(res, 429, { error: 'Terlalu banyak permintaan kontrol stream. Coba lagi sebentar.' });
    return;
  }
  let body: Record<string, unknown> = {};
  try {
    body = await readRequestJson(req);
  } catch {
    sendJson(res, 400, { error: 'Body JSON tidak valid.' });
    return;
  }
  const cameraId = String(body.cameraId || requestUrl.searchParams.get('camera') || '');
  if (!validCameraId(cameraId)) {
    sendJson(res, 400, { error: 'cameraId Surabaya tidak valid.' });
    return;
  }
  try {
    const result = await postAction(action, cameraId);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 502, { error: `Aksi ${action} Surabaya gagal: ${(error as Error).message}` });
  }
}

async function handleHls(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const cameraId = requestUrl.searchParams.get('camera') || '';
  const asset = requestUrl.searchParams.get('asset') || '';
  if (!validCameraId(cameraId) || !ASSET_RE.test(asset)) {
    sendJson(res, 400, { error: 'Parameter stream Surabaya tidak valid.' });
    return;
  }
  const cooldown = streamCooldown('surabaya', cameraId);
  if (cooldown) {
    sendCircuitResponse(res, cooldown, 'Stream Surabaya sedang tidak tersedia.');
    return;
  }

  const headers: Record<string, string> = { Accept: '*/*' };
  if (req.headers.range) headers.Range = String(req.headers.range);
  let upstream: http.IncomingMessage;
  try {
    upstream = await requestUpstream(
      `${SURABAYA_HLS_PATH.replace(/\/+$/, '')}/${encodeURIComponent(cameraId)}/${asset}`,
      'GET',
      headers
    );
  } catch (error) {
    noteStreamUnreachable('surabaya', cameraId);
    sendStreamGatewayError(res, `Proxy stream Surabaya gagal: ${(error as Error).message}`);
    return;
  }

  const status = upstream.statusCode || 0;
  if (status < 200 || status >= 300) {
    upstream.resume();
    if (status === 404 && asset.toLowerCase().endsWith('.m3u8')) {
      void postAction('start', cameraId).catch(() => undefined);
      res.setHeader('Retry-After', '1');
      sendJson(res, 503, { error: 'Manifest Surabaya belum siap.', upstreamStatus: status });
    } else {
      noteUpstreamStatus('surabaya', cameraId, status);
      sendUpstreamStreamError(res, status, `Stream Surabaya membalas HTTP ${status}.`, { upstreamStatus: status });
    }
    return;
  }
  noteStreamHealthy('surabaya', cameraId);

  const contentType = String(upstream.headers['content-type'] || '');
  if (asset.toLowerCase().endsWith('.m3u8') || contentType.toLowerCase().includes('mpegurl')) {
    try {
      const body = await readBody(upstream, MAX_PLAYLIST_BYTES);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.end(rewriteSurabayaPlaylist(body.toString('utf8'), cameraId));
    } catch (error) {
      if (!res.headersSent) sendJson(res, 502, { error: (error as Error).message });
    }
    return;
  }

  res.statusCode = status;
  res.setHeader('Content-Type', contentType || 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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
}

export async function handleSurabaya(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  setCors(res, req);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const requestUrl = new URL(req.url || '', 'http://localhost');
  const mode = requestUrl.searchParams.get('mode') || 'list';
  if (req.method === 'GET' && mode === 'list') {
    await handleList(res, requestUrl.searchParams.get('refresh') === '1');
    return;
  }
  if (req.method === 'GET' && mode === 'hls') {
    await handleHls(req, res, requestUrl);
    return;
  }
  if (req.method === 'POST' && (mode === 'start' || mode === 'stop')) {
    await handleAction(req, res, mode);
    return;
  }
  sendJson(res, 405, { error: 'Method/sumber Surabaya tidak valid.' });
}
