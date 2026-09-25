import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  REGIONAL_CCTV_USER_AGENT,
  SITUBONDO_BASE_URL,
  SITUBONDO_HLS_BASE,
  SITUBONDO_LIST_PATH,
  SITUBONDO_MJPEG_BASE,
  SITUBONDO_ZM_MAX_FPS,
  SITUBONDO_ZM_PASSWORD,
  SITUBONDO_ZM_SCALE,
  SITUBONDO_ZM_USERNAME,
} from './config.js';
import {
  pipeRegionalBinary,
  readRegionalText,
  regionalHeaders,
  regionalTarget,
  sendRegionalJson,
  setRegionalGetCors,
  REGIONAL_MAX_PLAYLIST_BYTES,
  REGIONAL_REQUEST_TIMEOUT_MS,
} from './regional-hls.js';
import { serveMjpegProxy } from './mjpeg-proxy.js';
import { redactLogMessage, shouldWriteProviderLog } from './request-log.js';

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
const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 60 * 1000;
const HLS_MONITORS = new Set(['1', '2', '3', '4', '5', '6', '8', '9']);
const MJPEG_MONITORS = new Set(['101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '111', '112', '113', '114', '115', '116', '117', '118', '119', '120', '121', '122', '123']);
const MONITOR_RE = /^\d{1,4}$/;
const baseUrl = new URL(SITUBONDO_BASE_URL.endsWith('/') ? SITUBONDO_BASE_URL : `${SITUBONDO_BASE_URL}/`);
const hlsBase = new URL(SITUBONDO_HLS_BASE.endsWith('/') ? SITUBONDO_HLS_BASE : `${SITUBONDO_HLS_BASE}/`);
const mjpegBase = new URL(SITUBONDO_MJPEG_BASE);

interface SitubondoCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: 'unknown';
  device_status: 'not_reported';
  source: 'situbondo';
  protocol: 'hls' | 'mjpeg';
  codec?: 'hls' | 'mjpeg';
  sourceCode: string;
  streamUrl: string;
  streamConfigured: boolean;
}

interface CacheEntry {
  ts: number;
  cameras: SitubondoCamera[];
}

interface SessionEntry {
  cookie: string;
  expiresAt: number;
}

let listCache: CacheEntry | null = seedListCache<SitubondoCamera>('situbondo');
let listInFlight: Promise<SitubondoCamera[]> | null = null;
let lastListWasStale = false;
const sessionCache = new Map<string, SessionEntry>();

function logSitubondo(level: 'info' | 'error', payload: Record<string, unknown>): void {
  if (!shouldWriteProviderLog(level)) return;
  if (level === 'info' && payload.event === 'stream-response') return;
  const line = `[lensamas-situbondo] ${JSON.stringify({ source: 'situbondo', ...payload })}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function validMonitor(value: string): boolean {
  return MONITOR_RE.test(value);
}

function mergeCookies(existing: string, response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const merged = new Map<string, string>();
  const existingItems = existing.split(';');
  for (const item of existingItems) {
    const trimmed = item.trim();
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    merged.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  for (const raw of values) {
    const firstPart = raw.split(';', 1)[0].trim();
    const separator = firstPart.indexOf('=');
    if (separator <= 0) continue;
    merged.set(firstPart.slice(0, separator), firstPart.slice(separator + 1));
  }
  return [...merged.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

function hlsTarget(monitor: string, asset: string): URL {
  if (!HLS_MONITORS.has(monitor) || !asset || asset.includes('..') || asset.includes('\\')) {
    throw new Error('Parameter stream HLS Situbondo tidak valid.');
  }
  const target = new URL(`cctv${monitor}/${asset}`, hlsBase);
  if (target.origin !== hlsBase.origin || !target.pathname.startsWith(`/cctv${monitor}/`)) {
    throw new Error('Target stream HLS Situbondo tidak diizinkan.');
  }
  return target;
}

function hlsAssetFromUrl(absolute: URL, monitor: string): string | null {
  if (absolute.origin !== hlsBase.origin || !absolute.pathname.startsWith(`/cctv${monitor}/`)) return null;
  const asset = absolute.pathname.slice(`/cctv${monitor}/`.length);
  if (!asset || asset.includes('..') || asset.includes('\\')) return null;
  return asset;
}

function proxyAssetUrl(monitor: string, asset: string): string {
  return `/api/hls-proxy?${new URLSearchParams({
    source: 'situbondo',
    mode: 'hls',
    camera: monitor,
    asset,
  }).toString()}`;
}

async function establishHlsSession(monitor: string, requestId: string): Promise<SessionEntry> {
  const cached = sessionCache.get(monitor);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const initUrl = hlsTarget(monitor, 'index.m3u8');
  const startedAt = Date.now();
  let response: Response;
  let cookie = '';
  try {
    response = await fetch(initUrl, {
      headers: regionalHeaders(REGIONAL_CCTV_USER_AGENT, { Accept: '*/*' }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
    });
    cookie = mergeCookies(cookie, response);
    for (let redirectCount = 0; redirectCount < 3 && response.status >= 300 && response.status < 400; redirectCount += 1) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect session Situbondo tidak memiliki Location.');
      const redirected = new URL(location, initUrl);
      if (redirected.origin !== hlsBase.origin || !redirected.pathname.startsWith(`/cctv${monitor}/`)) {
        throw new Error('Redirect session Situbondo di luar host/path yang diizinkan.');
      }
      response = await fetch(redirected, {
        headers: regionalHeaders(REGIONAL_CCTV_USER_AGENT, {
          Accept: '*/*',
          ...(cookie ? { Cookie: cookie } : {}),
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
      });
      cookie = mergeCookies(cookie, response);
    }
    if (!response.ok) throw new Error(`Session HLS Situbondo membalas HTTP ${response.status}.`);
    const text = await readRegionalText(response, REGIONAL_MAX_PLAYLIST_BYTES, 'session Situbondo');
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Session HLS Situbondo tidak mengembalikan playlist.');
    const entry = { cookie, expiresAt: Date.now() + SESSION_TTL_MS };
    sessionCache.set(monitor, entry);
    logSitubondo('info', {
      event: 'session-ready',
      requestId,
      monitor,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return entry;
  } catch (error) {
    logSitubondo('error', {
      event: 'session-error',
      requestId,
      monitor,
      durationMs: Date.now() - startedAt,
      error: redactLogMessage((error as Error).message),
    });
    throw error;
  }
}

async function fetchHls(
  monitor: string,
  asset: string,
  requestId: string,
  forceSession = false,
  range?: string
): Promise<{ response: Response; target: URL }> {
  if (forceSession) sessionCache.delete(monitor);
  const session = await establishHlsSession(monitor, requestId);
  let target = hlsTarget(monitor, asset);
  let cookie = session.cookie;
  const headers = regionalHeaders(REGIONAL_CCTV_USER_AGENT, {
    Accept: '*/*',
    ...(cookie ? { Cookie: cookie } : {}),
  });
  if (range) headers.Range = range;
  let response = await fetch(target, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
  });
  for (let redirectCount = 0; redirectCount < 3 && response.status >= 300 && response.status < 400; redirectCount += 1) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect HLS Situbondo tidak memiliki Location.');
    const redirected = new URL(location, target);
    if (redirected.origin !== hlsBase.origin || !redirected.pathname.startsWith(`/cctv${monitor}/`)) {
      throw new Error('Redirect HLS Situbondo di luar host/path yang diizinkan.');
    }
    cookie = mergeCookies(cookie, response);
    target = redirected;
    response = await fetch(target, {
      headers: regionalHeaders(REGIONAL_CCTV_USER_AGENT, {
        Accept: '*/*',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(range ? { Range: range } : {}),
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
    });
  }
  cookie = mergeCookies(cookie, response);
  sessionCache.set(monitor, { cookie, expiresAt: Date.now() + SESSION_TTL_MS });
  if ((response.status === 401 || response.status === 403) && !forceSession) {
    await response.body?.cancel().catch(() => undefined);
    return fetchHls(monitor, asset, requestId, true, range);
  }
  return { response, target };
}

async function handleHls(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  requestId: string
): Promise<void> {
  const monitor = requestUrl.searchParams.get('camera') || '';
  const asset = requestUrl.searchParams.get('asset') || 'index.m3u8';
  if (!HLS_MONITORS.has(monitor) || !/^[A-Za-z0-9._/-]+$/.test(asset) || asset.includes('..')) {
    sendRegionalJson(res, 400, { error: 'Parameter stream HLS Situbondo tidak valid.' });
    return;
  }
  const startedAt = Date.now();
  let result: { response: Response; target: URL };
  try {
    result = await fetchHls(monitor, asset, requestId, false, req.headers.range ? String(req.headers.range) : undefined);
  } catch (error) {
    logSitubondo('error', {
      event: 'stream-error',
      requestId,
      monitor,
      asset,
      durationMs: Date.now() - startedAt,
      error: redactLogMessage((error as Error).message),
    });
    noteStreamUnreachable('situbondo', monitor);
    sendStreamGatewayError(res, `Proxy stream HLS Situbondo gagal: ${(error as Error).message}`);
    return;
  }
  const { response, target } = result;
  logSitubondo('info', {
    event: 'stream-response',
    requestId,
    monitor,
    asset,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    noteUpstreamStatus('situbondo', monitor, response.status);
    sendUpstreamStreamError(res, response.status, `Stream HLS Situbondo membalas HTTP ${response.status}.`, {
      upstreamStatus: response.status,
    });
    return;
  }
  noteStreamHealthy('situbondo', monitor);
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (asset.toLowerCase().endsWith('.m3u8') || contentType.includes('mpegurl')) {
    try {
      const text = await readRegionalText(response, REGIONAL_MAX_PLAYLIST_BYTES, 'manifest HLS Situbondo');
      if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Manifest HLS Situbondo tidak valid.');
      const rewritten = rewritePlaylist(text, target, monitor);
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
  res.setHeader('Content-Type', response.headers.get('content-type') || 'video/mp4');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  for (const header of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = response.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  pipeRegionalBinary(response, res);
}

function rewritePlaylist(text: string, sourceUrl: URL, monitor: string): string {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/gi, (original, uri: string) => {
        try {
          const absolute = new URL(uri, sourceUrl);
          const asset = hlsAssetFromUrl(absolute, monitor);
          return asset ? `URI="${proxyAssetUrl(monitor, asset)}"` : original;
        } catch {
          return original;
        }
      });
    }
    try {
      const absolute = new URL(trimmed, sourceUrl);
      const asset = hlsAssetFromUrl(absolute, monitor);
      return asset ? proxyAssetUrl(monitor, asset) : line;
    } catch {
      return line;
    }
  }).join('\n');
}

async function handleMjpeg(
  _req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  requestId: string
): Promise<void> {
  const monitor = requestUrl.searchParams.get('camera') || '';
  if (!MJPEG_MONITORS.has(monitor)) {
    sendRegionalJson(res, 400, { error: 'Monitor MJPEG Situbondo tidak valid.' });
    return;
  }
  const username = SITUBONDO_ZM_USERNAME.trim();
  const password = SITUBONDO_ZM_PASSWORD.trim();
  if (!username || !password) {
    sendRegionalJson(res, 503, {
      error: 'Stream MJPEG Situbondo belum dikonfigurasi. Isi SITUBONDO_ZM_USERNAME dan SITUBONDO_ZM_PASSWORD di environment server.',
    });
    return;
  }
  const target = new URL(mjpegBase);
  if (target.protocol !== 'https:' || target.hostname !== 'cctvlive.situbondokab.go.id' || target.pathname !== '/zm/cgi-bin/nph-zms') {
    sendRegionalJson(res, 500, { error: 'Konfigurasi stream MJPEG Situbondo tidak valid.' });
    return;
  }
  const scale = Math.min(100, Math.max(1, Number(SITUBONDO_ZM_SCALE) || 50));
  const maxFps = Math.min(15, Math.max(1, Number(SITUBONDO_ZM_MAX_FPS) || 5));
  target.searchParams.set('mode', 'mjpeg');
  target.searchParams.set('monitor', monitor);
  target.searchParams.set('scale', String(scale));
  target.searchParams.set('maxfps', String(maxFps));
  target.searchParams.set('username', username);
  target.searchParams.set('password', password);

  await serveMjpegProxy(_req, res, {
    source: 'situbondo',
    monitor,
    requestId,
    target,
    expectedOrigin: 'https://cctvlive.situbondokab.go.id',
    pathPrefix: '/zm/cgi-bin/nph-zms',
    log: logSitubondo,
  });
}

async function fetchCameraList(requestId: string): Promise<SitubondoCamera[]> {
  const target = regionalTarget(baseUrl, SITUBONDO_LIST_PATH, 'Situbondo');
  const response = await fetch(target, {
    headers: regionalHeaders(REGIONAL_CCTV_USER_AGENT, { Accept: 'application/json' }),
    signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
  });
  logSitubondo('info', {
    event: 'metadata-response',
    requestId,
    status: response.status,
  });
  if (!response.ok) throw new Error(`API Situbondo membalas HTTP ${response.status}.`);
  const text = await readRegionalText(response, MAX_JSON_BYTES, 'metadata Situbondo');
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Respons API Situbondo bukan JSON yang valid.');
  }
  if (!Array.isArray(payload)) throw new Error('Respons API Situbondo bukan array.');
  const cameras: SitubondoCamera[] = [];
  const seen = new Set<string>();
  for (const value of payload) {
    if (!value || typeof value !== 'object') continue;
    const item = value as { monitor?: unknown; nama?: unknown; latitude?: unknown; longitude?: unknown };
    const monitor = String(item.monitor ?? '').trim();
    if (!validMonitor(monitor) || seen.has(monitor)) continue;
    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    const isHls = HLS_MONITORS.has(monitor);
    if (!isHls && !MJPEG_MONITORS.has(monitor)) continue;
    const name = typeof item.nama === 'string' && item.nama.trim() ? item.nama.trim().slice(0, 200) : `CCTV Situbondo ${monitor}`;
    seen.add(monitor);
    cameras.push({
      slug: `situbondo-${isHls ? 'hls' : 'zm'}-${monitor}`,
      name,
      location: 'Kabupaten Situbondo',
      latitude,
      longitude,
      status: 'unknown',
      device_status: 'not_reported',
      source: 'situbondo',
      protocol: isHls ? 'hls' : 'mjpeg',
      codec: isHls ? 'hls' : 'mjpeg',
      sourceCode: `${isHls ? 'hls' : 'zm'}:${monitor}`,
      streamUrl: isHls
        ? proxyAssetUrl(monitor, 'index.m3u8')
        : `/api/hls-proxy?${new URLSearchParams({ source: 'situbondo', mode: 'mjpeg', camera: monitor }).toString()}`,
      streamConfigured: isHls || Boolean(SITUBONDO_ZM_USERNAME.trim() && SITUBONDO_ZM_PASSWORD.trim()),
    });
  }
  if (cameras.length === 0) throw new Error('API Situbondo tidak memuat kamera yang valid.');
  return cameras;
}

async function getSitubondoCameras(forceRefresh = false, requestId = 'unknown'): Promise<SitubondoCamera[]> {
  const now = Date.now();
  if (!forceRefresh && listCache && now - listCache.ts < LIST_CACHE_TTL_MS) return listCache.cameras;
  if (listInFlight) return listInFlight;
  listInFlight = fetchCameraList(requestId)
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

export async function handleSitubondo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setRegionalGetCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendRegionalJson(res, 405, { error: 'Method Situbondo tidak valid.' });
    return;
  }
  const requestUrl = new URL(req.url || '', 'http://localhost');
  const mode = requestUrl.searchParams.get('mode') || 'list';
  const requestId = String(res.getHeader('X-Request-Id') || 'unknown');
  if (mode === 'list') {
    try {
      const cameras = await getSitubondoCameras(requestUrl.searchParams.get('refresh') === '1', requestId);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=900');
      res.setHeader('X-Lensamas-Data', lastListWasStale ? 'stale' : 'fresh');
      res.setHeader('X-Lensamas-Stale', lastListWasStale ? '1' : '0');
      res.end(JSON.stringify({ data: markOfflineCameras('situbondo', cameras), source: 'situbondo' }));
    } catch (error) {
      sendDegradedList(res, 'situbondo', listCache?.cameras || [], (error as Error).message);
    }
    return;
  }
  if (mode === 'hls') {
    await handleHls(req, res, requestUrl, requestId);
    return;
  }
  if (mode === 'mjpeg') {
    await handleMjpeg(req, res, requestUrl, requestId);
    return;
  }
  sendRegionalJson(res, 400, { error: 'Mode Situbondo tidak valid.' });
}
