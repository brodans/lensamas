import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import {
  APP_ORIGIN,
  GRESIK_BASE_URL,
  GRESIK_CCTV_PATH,
  GRESIK_HLS_PATH,
  GRESIK_LOCATIONS_PATH,
  GRESIK_MARKERS_PATH,
  GRESIK_USER_AGENT,
} from './config.js';
import { readOpaqueQuery, rememberOpaqueQuery } from './opaque-query.js';

import {
  sendDegradedList,
  sendUpstreamStreamError,
} from './regional-hls.js';
import { seedListCache } from './list-snapshot.js';
import {
  noteUpstreamStatus,
  markOfflineCameras,
  noteStreamHealthy,
} from './stream-circuit.js';

const MAX_JSON_BYTES = 3 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const LIST_CACHE_TTL_MS = 60 * 1000;
const LOCATION_CACHE_TTL_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const baseUrl = new URL(GRESIK_BASE_URL.endsWith('/') ? GRESIK_BASE_URL : `${GRESIK_BASE_URL}/`);
const hlsBasePath = GRESIK_HLS_PATH.replace(/\/+$/, '');

type JsonRecord = Record<string, unknown>;

interface GresikCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: 'online' | 'offline';
  source: 'gresik';
  protocol: 'hls';
  streamUrl?: string;
  sourceCode: string;
  thumbUrl?: string;
}

interface Marker {
  id: string;
  locationId: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: string;
  thumbnail?: string;
}

interface LocationPayload {
  location?: {
    name?: unknown;
    address?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  };
  cctv?: unknown[];
}

interface CacheEntry {
  ts: number;
  cameras: GresikCamera[];
}

let listCache: CacheEntry | null = seedListCache<GresikCamera>('gresik');
let listInFlight: Promise<GresikCamera[]> | null = null;
let lastListWasStale = false;
const locationCache = new Map<string, { ts: number; payload: LocationPayload }>();
const controlWindows = new Map<string, { startedAt: number; count: number }>();

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
  res.setHeader('X-Content-Type-Options', 'nosniff');
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
  return current.count > 60;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function safeAsset(value: string): boolean {
  return Boolean(
    value &&
    value.length <= 512 &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': GRESIK_USER_AGENT,
    ...extra,
  };
}

function targetUrl(path: string): URL {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) throw new Error('Path Gresik di luar origin yang diizinkan.');
  return url;
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(targetUrl(path), {
    headers: requestHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Gresik membalas HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > MAX_JSON_BYTES) throw new Error('Respons API Gresik terlalu besar.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Respons API Gresik bukan JSON yang valid.');
  }
}

function normalizeStatus(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function parseMarker(value: unknown): Marker | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as JsonRecord;
  const id = typeof item.marker_id === 'string' ? item.marker_id : '';
  const latitude = Number(item.latitude);
  const longitude = Number(item.longitude);
  if (!isUuid(id) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'CCTV Gresik';
  const location = typeof item.location_name === 'string' && item.location_name.trim()
    ? item.location_name.trim()
    : 'Kabupaten Gresik';
  const thumbnail = typeof item.thumbnail === 'string' && item.thumbnail.trim() ? item.thumbnail.trim() : undefined;
  return {
    id,
    locationId: typeof item.location_id === 'string' ? item.location_id : '',
    name,
    location,
    latitude,
    longitude,
    status: normalizeStatus(item.status),
    thumbnail,
  };
}

async function getLocation(locationId: string, forceRefresh = false): Promise<LocationPayload> {
  const now = Date.now();
  const cached = locationCache.get(locationId);
  if (!forceRefresh && cached && now - cached.ts < LOCATION_CACHE_TTL_MS) return cached.payload;
  const path = `${GRESIK_LOCATIONS_PATH.replace(/\/+$/, '')}/${encodeURIComponent(locationId)}`;
  const payload = await fetchJson(path) as LocationPayload;
  if (!payload || typeof payload !== 'object') throw new Error('Payload lokasi Gresik tidak valid.');
  locationCache.set(locationId, { ts: now, payload });
  return payload;
}

function streamPathFromHls(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value, baseUrl);
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith(`${hlsBasePath}/`)) return '';
    const path = url.pathname.slice(hlsBasePath.length + 1);
    const stream = path.split('/').slice(0, -1).join('/');
    return safeAsset(stream) ? stream : '';
  } catch {
    return '';
  }
}

function normalizeCamera(
  marker: Marker,
  item: JsonRecord,
  location: LocationPayload
): GresikCamera | null {
  const id = typeof item.id === 'string' ? item.id : marker.id;
  if (!isUuid(id)) return null;
  const streamPath = streamPathFromHls(item.hls_url);
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : marker.name;
  const locationName = typeof location.location?.name === 'string' && location.location.name.trim()
    ? location.location.name.trim()
    : marker.location;
  const address = typeof location.location?.address === 'string' && location.location.address.trim()
    ? ` — ${location.location.address.trim()}`
    : '';
  const status = normalizeStatus(item.status) || marker.status;
  const streamUrl = streamPath
    ? `/api/hls-proxy?${new URLSearchParams({
        source: 'gresik',
        mode: 'hls',
        camera: id,
        stream: streamPath,
        asset: 'index.m3u8',
      }).toString()}`
    : undefined;
  return {
    slug: `gresik-${id}`,
    name,
    location: `${locationName}${address}`,
    latitude: marker.latitude,
    longitude: marker.longitude,
    status: status === 'online' && streamUrl ? 'online' : 'offline',
    source: 'gresik',
    protocol: 'hls',
    ...(streamUrl ? { streamUrl } : {}),
    sourceCode: id,
    thumbUrl: typeof item.thumbnail === 'string' && item.thumbnail.trim()
      ? new URL(item.thumbnail, baseUrl).href
      : marker.thumbnail
        ? new URL(marker.thumbnail, baseUrl).href
        : undefined,
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index]);
    }
  }));
  return output;
}

async function loadGresikCameras(forceRefresh = false): Promise<GresikCamera[]> {
  const now = Date.now();
  if (!forceRefresh && listCache && now - listCache.ts < LIST_CACHE_TTL_MS) return listCache.cameras;

  try {
    const raw = await fetchJson(GRESIK_MARKERS_PATH);
    const rawRecord = raw && typeof raw === 'object' ? raw as JsonRecord : {};
    const markerValues = Array.isArray(rawRecord.markers) ? rawRecord.markers : [];
    const markers = markerValues.map(parseMarker).filter((marker): marker is Marker => Boolean(marker));
    if (markers.length === 0) throw new Error('API publik Gresik tidak mengembalikan marker CCTV.');
    const byId = new Map(markers.map((marker) => [marker.id, marker]));
    const locationIds = [...new Set(markers.map((marker) => marker.locationId).filter(Boolean))];

    // Marker per_device tidak selalu menyertakan hls_url. Ambil detail lokasi
    // secara paralel dan tolerant: satu lokasi yang bermasalah tidak menghapus
    // kamera dari lokasi lain.
    const locationValues = await mapWithConcurrency(locationIds, 8, async (locationId) => {
      try {
        return { locationId, payload: await getLocation(locationId, forceRefresh) };
      } catch {
        return { locationId, payload: null };
      }
    });
    const locations = new Map(locationValues.map((item) => [item.locationId, item.payload]));
    const cameras: GresikCamera[] = [];
    const seen = new Set<string>();
    for (const [locationId, location] of locations) {
      if (!location || !Array.isArray(location.cctv)) continue;
      for (const value of location.cctv) {
        if (!value || typeof value !== 'object') continue;
        const item = value as JsonRecord;
        const id = typeof item.id === 'string' ? item.id : '';
        const marker = byId.get(id) || byId.get(`${locationId}:${id}`);
        if (!marker || seen.has(id)) continue;
        const camera = normalizeCamera(marker, item, location);
        if (!camera) continue;
        seen.add(id);
        cameras.push(camera);
      }
    }

    // Jika detail lokasi sedang lambat/gagal, tetap pertahankan marker
    // metadata sebagai kamera offline daripada mengembalikan 0 kamera.
    for (const marker of markers) {
      if (seen.has(marker.id)) continue;
      cameras.push({
        slug: `gresik-${marker.id}`,
        name: marker.name,
        location: marker.location,
        latitude: marker.latitude,
        longitude: marker.longitude,
        status: 'offline',
        source: 'gresik',
        protocol: 'hls',
        sourceCode: marker.id,
        ...(marker.thumbnail ? { thumbUrl: new URL(marker.thumbnail, baseUrl).href } : {}),
      });
      seen.add(marker.id);
    }

    if (cameras.length === 0) throw new Error('Tidak ada kamera Gresik yang valid.');
    listCache = { ts: now, cameras };
    lastListWasStale = false;
    return cameras;
  } catch (error) {
    if (listCache) {
      lastListWasStale = true;
      return listCache.cameras;
    }
    throw error;
  }
}

function getGresikCameras(forceRefresh = false): Promise<GresikCamera[]> {
  const now = Date.now();
  if (!forceRefresh && listCache && now - listCache.ts < LIST_CACHE_TTL_MS) {
    return Promise.resolve(listCache.cameras);
  }
  if (listInFlight) return listInFlight;
  listInFlight = loadGresikCameras(forceRefresh).finally(() => {
    listInFlight = null;
  });
  return listInFlight;
}

function proxyAssetUrl(camera: string, stream: string, asset: string, query: string): string {
  const params = new URLSearchParams({ source: 'gresik', mode: 'hls', camera, stream, asset });
  if (query) params.set('queryId', rememberOpaqueQuery(`gresik:${camera}`, query.slice(0, 2048)));
  return `/api/hls-proxy?${params.toString()}`;
}

function rewritePlaylist(text: string, sourceUrl: URL, camera: string, stream: string): string {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/gi, (original, uri: string) => {
        try {
          const absolute = new URL(uri, sourceUrl);
          if (absolute.origin !== baseUrl.origin || !absolute.pathname.startsWith(`${hlsBasePath}/`)) return original;
          const path = absolute.pathname.slice(hlsBasePath.length + 1);
          const currentStream = path.split('/').slice(0, -1).join('/');
          const asset = path.split('/').pop() || '';
          if (!safeAsset(asset) || (currentStream && currentStream !== stream)) return original;
          return `URI="${proxyAssetUrl(camera, stream, asset, absolute.search.slice(1))}"`;
        } catch {
          return original;
        }
      });
    }
    try {
      const absolute = new URL(trimmed, sourceUrl);
      if (absolute.origin !== baseUrl.origin || !absolute.pathname.startsWith(`${hlsBasePath}/`)) return line;
      const path = absolute.pathname.slice(hlsBasePath.length + 1);
      const currentStream = path.split('/').slice(0, -1).join('/');
      const asset = path.split('/').pop() || '';
      return safeAsset(asset) && currentStream === stream
        ? proxyAssetUrl(camera, stream, asset, absolute.search.slice(1))
        : line;
    } catch {
      return line;
    }
  }).join('\n');
}

async function readPlaylist(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > MAX_PLAYLIST_BYTES) throw new Error('Manifest Gresik terlalu besar.');
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

async function handleList(res: ServerResponse, forceRefresh: boolean): Promise<void> {
  try {
    const cameras = await getGresikCameras(forceRefresh);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
    res.setHeader('X-Lensamas-Data', lastListWasStale ? 'stale' : 'fresh');
    res.end(JSON.stringify({ data: markOfflineCameras('gresik', cameras), source: 'gresik' }));
  } catch (error) {
    sendDegradedList(res, 'gresik', listCache?.cameras || [], (error as Error).message);
  }
}

async function readRequestJson(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8192) throw new Error('Body JSON terlalu besar.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return value && typeof value === 'object' ? value as JsonRecord : {};
  } catch {
    return {};
  }
}

async function handleAction(
  req: IncomingMessage,
  res: ServerResponse,
  action: 'start' | 'heartbeat' | 'stop'
): Promise<void> {
  if (!isAllowedControlOrigin(req)) {
    sendJson(res, 403, { error: 'Origin kontrol stream tidak diizinkan.' });
    return;
  }
  if (isControlRateLimited(req)) {
    sendJson(res, 429, { error: 'Terlalu banyak permintaan kontrol stream. Coba lagi sebentar.' });
    return;
  }
  let body: JsonRecord;
  try {
    body = await readRequestJson(req);
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
    return;
  }
  const cameraId = typeof body.cameraId === 'string' ? body.cameraId : '';
  const viewerId = typeof body.viewerId === 'string' ? body.viewerId : '';
  if (!isUuid(cameraId) || !isUuid(viewerId)) {
    sendJson(res, 400, { error: 'cameraId atau viewerId Gresik tidak valid.' });
    return;
  }
  const url = targetUrl(`${GRESIK_CCTV_PATH.replace(/\/+$/, '')}/${encodeURIComponent(cameraId)}/${action}`);
  url.searchParams.set('viewer_id', viewerId);
  if (action === 'start') {
    url.searchParams.set('context', 'public');
    url.searchParams.set('quality', 'auto');
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders({ 'Content-Length': '0' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      noteUpstreamStatus('gresik', cameraId, response.status);
      sendUpstreamStreamError(res, response.status, `Aksi ${action} Gresik membalas HTTP ${response.status}.`, {
        upstreamStatus: response.status,
      });
      return;
    }
    try {
      sendJson(res, 200, JSON.parse(text) as unknown);
    } catch {
      sendJson(res, 200, { ok: true });
    }
  } catch (error) {
    sendJson(res, 502, { error: `Aksi ${action} Gresik gagal: ${(error as Error).message}` });
  }
}

async function handleHls(req: IncomingMessage, res: ServerResponse, requestUrl: URL): Promise<void> {
  const camera = requestUrl.searchParams.get('camera') || '';
  const stream = requestUrl.searchParams.get('stream') || '';
  const asset = requestUrl.searchParams.get('asset') || 'index.m3u8';
  const queryId = requestUrl.searchParams.get('queryId');
  const sourceQuery = readOpaqueQuery(`gresik:${camera}`, queryId);
  if (!isUuid(camera) || !safeAsset(stream) || !safeAsset(asset) || (queryId && !sourceQuery)) {
    sendJson(res, 400, { error: 'Parameter stream Gresik tidak valid.' });
    return;
  }

  const target = targetUrl(`${hlsBasePath}/${stream}/${asset}`);
  if (!target.pathname.startsWith(`${hlsBasePath}/${stream}/`)) {
    sendJson(res, 400, { error: 'Target stream Gresik tidak diizinkan.' });
    return;
  }
  if (sourceQuery) target.search = sourceQuery;
  const headers = requestHeaders({ Accept: '*/*' });
  if (req.headers.range) headers.Range = String(req.headers.range);

  let response: Response;
  try {
    response = await fetch(target, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    sendJson(res, 502, { error: `Proxy stream Gresik gagal: ${(error as Error).message}` });
    return;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    noteUpstreamStatus('gresik', camera, response.status);
    sendUpstreamStreamError(res, response.status, `Stream Gresik membalas HTTP ${response.status}.`, {
      upstreamStatus: response.status,
    });
    return;
  }
  noteStreamHealthy('gresik', camera);

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (asset.toLowerCase().endsWith('.m3u8') || contentType.includes('mpegurl')) {
    try {
      const text = await readPlaylist(response);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.end(rewritePlaylist(text, target, camera, stream));
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

export async function handleGresik(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  if (req.method === 'POST' && (mode === 'start' || mode === 'heartbeat' || mode === 'stop')) {
    await handleAction(req, res, mode);
    return;
  }
  if (req.method === 'GET' && mode === 'hls') {
    await handleHls(req, res, requestUrl);
    return;
  }
  sendJson(res, 405, { error: 'Method/mode Gresik tidak valid.' });
}
