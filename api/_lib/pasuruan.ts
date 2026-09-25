import type { IncomingMessage, ServerResponse } from 'node:http';
import * as https from 'node:https';
import { inflateRawSync } from 'node:zlib';
import * as tls from 'node:tls';

import {
  PASURUAN_BASE_URL,
  PASURUAN_GEOJSON_MARKER,
  PASURUAN_GEOJSON_PATH,
  PASURUAN_STREAM_BASE,
  REGIONAL_CCTV_USER_AGENT,
} from './config.js';
import { redactLogMessage, shouldWriteProviderLog } from './request-log.js';
import {
  regionalHeaders,
  regionalTarget,
  sendRegionalJson,
  setRegionalGetCors,
  REGIONAL_MAX_PLAYLIST_BYTES,
  REGIONAL_REQUEST_TIMEOUT_MS,
} from './regional-hls.js';
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

const MAX_ZIP_BYTES = 5 * 1024 * 1024;
const MAX_GEOJSON_BYTES = 2 * 1024 * 1024;
const LIST_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_REDIRECTS = 3;
const CAMERA_RE = /^\d{1,10}$/;
const ASSET_RE = /^[A-Za-z0-9._-]{1,256}$/;
const STREAM_HOST = 'dishub.pasuruankab.go.id';
const STREAM_PATH_PREFIX = '/LiveApp/streams/';

// DigiCert Global G2 TLS RSA SHA256 2020 CA1. The public upstream omits this
// intermediate from its TLS chain; TLS verification remains enabled here.
const DIGICERT_GLOBAL_G2_INTERMEDIATE = `-----BEGIN CERTIFICATE-----
MIIEyDCCA7CgAwIBAgIQDPW9BitWAvR6uFAsI8zwZjANBgkqhkiG9w0BAQsFADBh
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSAwHgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBH
MjAeFw0yMTAzMzAwMDAwMDBaFw0zMTAzMjkyMzU5NTlaMFkxCzAJBgNVBAYTAlVT
MRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxMzAxBgNVBAMTKkRpZ2lDZXJ0IEdsb2Jh
bCBHMiBUTFMgUlNBIFNIQTI1NiAyMDIwIENBMTCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAMz3EGJPprtjb+2QUlbFbSd7ehJWivH0+dbn4Y+9lavyYEEV
cNsSAPonCrVXOFt9slGTcZUOakGUWzUb+nv6u8W+JDD+Vu/E832X4xT1FE3LpxDy
FuqrIvAxIhFhaZAmunjZlx/jfWardUSVc8is/+9dCopZQ+GssjoP80j812s3wWPc
3kbW20X+fSP9kOhRBx5Ro1/tSUZUfyyIxfQTnJcVPAPooTncaQwywa8WV0yUR0J8
osicfebUTVSvQpmowQTCd5zWSOTOEeAqgJnwQ3DPP3Zr0UxJqyRewg2C/Uaoq2yT
zGJSQnWS+Jr6Xl6ysGHlHx+5fwmY6D36g39HaaECAwEAAaOCAYIwggF+MBIGA1Ud
EwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFHSFgMBmx9833s+9KTeqAx2+7c0XMB8G
A1UdIwQYMBaAFE4iVCAYlebjbuYP+vq5Eu0GF485MA4GA1UdDwEB/wQEAwIBhjAd
BgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwdgYIKwYBBQUHAQEEajBoMCQG
CCsGAQUFBzABhhhodHRwOi8vb2NzcC5kaWdpY2VydC5jb20wQAYIKwYBBQUHMAKG
NGh0dHA6Ly9jYWNlcnRzLmRpZ2ljZXJ0LmNvbS9EaWdpQ2VydEdsb2JhbFJvb3RH
Mi5jcnQwQgYDVR0fBDswOTA3oDWgM4YxaHR0cDovL2NybDMuZGlnaWNlcnQuY29t
L0RpZ2lDZXJ0R2xvYmFsUm9vdEcyLmNybDA9BgNVHSAENjA0MAsGCWCGSAGG/WwC
ATAHBgVngQwBATAIBgZngQwBAgEwCAYGZ4EMAQICMAgGBmeBDAECAzANBgkqhkiG
9w0BAQsFAAOCAQEAkPFwyyiXaZd8dP3A+iZ7U6utzWX9upwGnIrXWkOH7U1MVl+t
wcW1BSAuWdH/SvWgKtiwla3JLko716f2b4gp/DA/JIS7w7d7kwcsr4drdjPtAFVS
slme5LnQ89/nD/7d+MS5EHKBCQRfz5eeLjJ1js+aWNJXMX43AYGyZm0pGrFmCW3R
bpD0ufovARTFXFZkAdl9h6g4U5+LXUZtXMYnhIHUfoyMo5tS58aI7Dd8KvvwVVo4
chDYABPPTHPbqjc1qCmBaZx2vN4Ye5DUys/vZwP9BFohFrH/6j/f3IL16/RZkiMN
JCqVJUzKoZHm1Lesh3Sz8W2jmdv51b2EQJ8HmA==
-----END CERTIFICATE-----`;

interface PasuruanCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: 'unknown';
  device_status: 'not_reported';
  source: 'pasuruan';
  protocol: 'hls';
  sourceCode: string;
  streamUrl?: string;
}

interface CacheEntry {
  ts: number;
  cameras: PasuruanCamera[];
}

interface UpstreamResult {
  response: IncomingMessage;
  finalUrl: URL;
}

const baseUrl = new URL(PASURUAN_BASE_URL.endsWith('/') ? PASURUAN_BASE_URL : `${PASURUAN_BASE_URL}/`);
const streamBase = new URL(PASURUAN_STREAM_BASE.endsWith('/') ? PASURUAN_STREAM_BASE : `${PASURUAN_STREAM_BASE}/`);
const hlsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });
const streamOrigin = `${streamBase.protocol}//${streamBase.host}`;
let listCache: CacheEntry | null = seedListCache<PasuruanCamera>('pasuruan');
let listInFlight: Promise<PasuruanCamera[]> | null = null;
let lastListWasStale = false;
const streamAssetCache = new Map<string, string>();

function logPasuruan(level: 'info' | 'error', payload: Record<string, unknown>): void {
  if (!shouldWriteProviderLog(level)) return;
  if (level === 'info' && (payload.event === 'stream-response' || payload.event === 'stream-asset')) return;
  const line = `[lensamas-pasuruan] ${JSON.stringify({ source: 'pasuruan', ...payload })}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function proxyAssetUrl(camera: string, asset: string): string {
  return `/api/hls-proxy?${new URLSearchParams({
    source: 'pasuruan',
    mode: 'hls',
    camera,
    asset,
  }).toString()}`;
}

function isStreamTarget(target: URL): boolean {
  return target.origin === streamOrigin && target.pathname.startsWith(STREAM_PATH_PREFIX);
}

function parseGeojson(text: string): Array<{ id: string; name: string; latitude: number; longitude: number }> {
  let payload: { features?: unknown };
  try {
    payload = JSON.parse(text) as { features?: unknown };
  } catch {
    throw new Error('GeoJSON Pasuruan bukan JSON yang valid.');
  }
  if (!Array.isArray(payload.features)) throw new Error('GeoJSON Pasuruan tidak memiliki features.');
  const rows: Array<{ id: string; name: string; latitude: number; longitude: number }> = [];
  const seen = new Set<string>();
  for (const value of payload.features) {
    if (!value || typeof value !== 'object') continue;
    const feature = value as { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> };
    const properties = feature.properties || {};
    const id = String(properties.object_id ?? '').trim();
    const coordinates = Array.isArray(feature.geometry?.coordinates) ? feature.geometry.coordinates : [];
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);
    const name = typeof properties.label === 'string' && properties.label.trim()
      ? decodeHtml(properties.label).slice(0, 200)
      : `CCTV Pasuruan ${id}`;
    if (!CAMERA_RE.test(id) || seen.has(id) || !name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    seen.add(id);
    rows.push({ id, name, latitude, longitude });
  }
  if (rows.length === 0) throw new Error('GeoJSON Pasuruan tidak memuat kamera yang valid.');
  return rows;
}

function extractGeojson(zipBuffer: Buffer): string {
  let offset = 0;
  while (offset + 30 <= zipBuffer.length) {
    if (zipBuffer.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const method = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 22);
    const nameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraLength = zipBuffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBuffer.length) throw new Error('ZIP GeoJSON Pasuruan terpotong.');
    const name = zipBuffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    if (name === 'doc.geojson') {
      if (uncompressedSize > MAX_GEOJSON_BYTES) throw new Error('GeoJSON Pasuruan terlalu besar.');
      const compressed = zipBuffer.subarray(dataStart, dataEnd);
      const output = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (!output) throw new Error('Kompresi GeoJSON Pasuruan tidak didukung.');
      if (output.length > MAX_GEOJSON_BYTES) throw new Error('GeoJSON Pasuruan terlalu besar.');
      return output.toString('utf8');
    }
    offset = dataEnd;
  }
  throw new Error('ZIP GeoJSON Pasuruan tidak memuat doc.geojson.');
}

async function resolveStreamAsset(cameraId: string, requestId: string): Promise<string> {
  const cached = streamAssetCache.get(cameraId);
  if (cached) return cached;
  const endpoint = regionalTarget(baseUrl, PASURUAN_GEOJSON_PATH, 'Pasuruan');
  const body = new URLSearchParams({ objectID: cameraId });
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: regionalHeaders(REGIONAL_CCTV_USER_AGENT, {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    }),
    body,
    signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Detail stream Pasuruan ${cameraId} membalas HTTP ${response.status}.`);
  const payload = await response.json() as { content?: unknown };
  if (typeof payload.content !== 'string') throw new Error(`Detail stream Pasuruan ${cameraId} tidak berisi content.`);
  const sourceMatch = payload.content.match(/<source\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/i);
  if (!sourceMatch) throw new Error(`Detail stream Pasuruan ${cameraId} tidak memiliki source HLS.`);
  let source: URL;
  try {
    source = new URL(decodeHtml(sourceMatch[2]));
  } catch {
    throw new Error(`URL stream Pasuruan ${cameraId} tidak valid.`);
  }
  const normalizedPath = source.pathname.replace(/^\/+/, '/');
  if (source.origin !== streamOrigin || !normalizedPath.startsWith(STREAM_PATH_PREFIX)) {
    throw new Error(`URL stream Pasuruan ${cameraId} di luar host/path yang diizinkan.`);
  }
  const asset = normalizedPath.slice(STREAM_PATH_PREFIX.length);
  if (!ASSET_RE.test(asset) || !asset.toLowerCase().endsWith('.m3u8')) {
    throw new Error(`Asset stream Pasuruan ${cameraId} tidak valid.`);
  }
  streamAssetCache.set(cameraId, asset);
  logPasuruan('info', { event: 'stream-asset', requestId, camera: cameraId, status: response.status });
  return asset;
}

async function fetchCameraList(): Promise<PasuruanCamera[]> {
  const endpoint = regionalTarget(baseUrl, PASURUAN_GEOJSON_PATH, 'Pasuruan');
  const bootstrap = await fetch(endpoint, {
    method: 'POST',
    headers: regionalHeaders(REGIONAL_CCTV_USER_AGENT, {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    }),
    body: new URLSearchParams({ per_page: '0', 'marker[]': PASURUAN_GEOJSON_MARKER }),
    signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
  });
  if (!bootstrap.ok) throw new Error(`Bootstrap GeoJSON Pasuruan membalas HTTP ${bootstrap.status}.`);
  const bootstrapPayload = await bootstrap.json() as { url?: unknown };
  if (typeof bootstrapPayload.url !== 'string') throw new Error('Bootstrap GeoJSON Pasuruan tidak memiliki URL download.');
  let downloadUrl: URL;
  try {
    downloadUrl = new URL(bootstrapPayload.url);
  } catch {
    throw new Error('URL download GeoJSON Pasuruan tidak valid.');
  }
  if (downloadUrl.protocol !== 'https:' || downloadUrl.hostname !== STREAM_HOST || (downloadUrl.port && downloadUrl.port !== '443') || !/^\/maps\/ajax\/geojson\/[a-f0-9]{40}$/i.test(downloadUrl.pathname)) {
    throw new Error('URL download GeoJSON Pasuruan di luar host/path yang diizinkan.');
  }
  const zipResponse = await fetch(downloadUrl, {
    headers: regionalHeaders(REGIONAL_CCTV_USER_AGENT, { Accept: 'application/octet-stream' }),
    signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
  });
  if (!zipResponse.ok) throw new Error(`Download GeoJSON Pasuruan membalas HTTP ${zipResponse.status}.`);
  const zipBuffer = Buffer.from(await zipResponse.arrayBuffer());
  if (zipBuffer.length > MAX_ZIP_BYTES) throw new Error('ZIP GeoJSON Pasuruan terlalu besar.');
  const rows = parseGeojson(extractGeojson(zipBuffer));
  // Asset stream Pasuruan sengaja TIDAK diambil satu per satu di sini. Resolusi
  // per kamera hanya dilakukan saat pengguna benar-benar membuka kamera (satu
  // POST), bukan untuk puluhan kamera setiap kali list di-refresh.
  return rows.map((row) => ({
    slug: `pasuruan-${row.id}`,
    name: row.name,
    location: 'Kabupaten Pasuruan',
    latitude: row.latitude,
    longitude: row.longitude,
    status: 'unknown' as const,
    device_status: 'not_reported',
    source: 'pasuruan' as const,
    protocol: 'hls' as const,
    sourceCode: row.id,
    streamUrl: `/api/hls-proxy?${new URLSearchParams({
      source: 'pasuruan',
      mode: 'hls',
      camera: row.id,
    }).toString()}`,
  }));
}

async function getPasuruanCameras(forceRefresh = false): Promise<PasuruanCamera[]> {
  const now = Date.now();
  if (!forceRefresh && listCache && now - listCache.ts < LIST_CACHE_TTL_MS) return listCache.cameras;
  if (listInFlight) return listInFlight;
  listInFlight = fetchCameraList()
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

function requestHls(target: URL, headers: Record<string, string>, redirectCount = 0): Promise<UpstreamResult> {
  if (!isStreamTarget(target)) return Promise.reject(new Error('Target HLS Pasuruan di luar host/path yang diizinkan.'));
  if (target.protocol !== 'https:') return Promise.reject(new Error('Target HLS Pasuruan harus HTTPS.'));
  return new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: 'GET',
      rejectUnauthorized: true,
      ca: [...tls.rootCertificates, DIGICERT_GLOBAL_G2_INTERMEDIATE],
      agent: hlsAgent,
      headers,
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error('Terlalu banyak redirect HLS Pasuruan.'));
          return;
        }
        try {
          const redirected = new URL(location, target);
          void requestHls(redirected, headers, redirectCount + 1).then(resolve, reject);
        } catch {
          reject(new Error('Redirect HLS Pasuruan tidak valid.'));
        }
        return;
      }
      resolve({ response, finalUrl: target });
    });
    request.setTimeout(REGIONAL_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Koneksi HLS Pasuruan habis waktu.')));
    request.on('error', reject);
    request.end();
  });
}

function readIncomingText(response: IncomingMessage, maxBytes: number, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value || '');
    };
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy();
        finish(new Error(`${label} terlalu besar.`));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => finish(undefined, Buffer.concat(chunks).toString('utf8')));
    response.on('aborted', () => finish(new Error(`${label} terputus.`)));
    response.on('error', (error) => finish(error));
  });
}

function pipeIncoming(response: IncomingMessage, res: ServerResponse): void {
  res.on('close', () => response.destroy());
  response.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders();
  response.pipe(res);
}

function rewritePlaylist(text: string, sourceUrl: URL, camera: string): string {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/gi, (original, uri: string) => {
        try {
          const absolute = new URL(uri, sourceUrl);
          if (!isStreamTarget(absolute)) return original;
          const asset = absolute.pathname.slice(STREAM_PATH_PREFIX.length);
          return ASSET_RE.test(asset) ? `URI="${proxyAssetUrl(camera, asset)}"` : original;
        } catch {
          return original;
        }
      });
    }
    try {
      const absolute = new URL(trimmed, sourceUrl);
      if (!isStreamTarget(absolute)) return line;
      const asset = absolute.pathname.slice(STREAM_PATH_PREFIX.length);
      return ASSET_RE.test(asset) ? proxyAssetUrl(camera, asset) : line;
    } catch {
      return line;
    }
  }).join('\n');
}

async function handleHls(req: IncomingMessage, res: ServerResponse, requestUrl: URL, requestId: string): Promise<void> {
  const camera = requestUrl.searchParams.get('camera') || '';
  if (!CAMERA_RE.test(camera)) {
    sendRegionalJson(res, 400, { error: 'Parameter stream HLS Pasuruan tidak valid.' });
    return;
  }
  const cooldown = streamCooldown('pasuruan', camera);
  if (cooldown) {
    sendCircuitResponse(res, cooldown, 'Stream Pasuruan sedang tidak tersedia.');
    return;
  }
  if (!streamAssetCache.has(camera)) {
    // Resolusi lazy: satu POST per kamera yang benar-benar dibuka, bukan satu
    // POST per kamera pada setiap refresh list.
    try {
      await resolveStreamAsset(camera, requestId);
    } catch (error) {
      logPasuruan('error', {
        event: 'stream-asset-error',
        requestId,
        camera,
        error: redactLogMessage((error as Error).message),
      });
      sendStreamGatewayError(res, `Stream Pasuruan tidak dapat disiapkan: ${(error as Error).message}`);
      return;
    }
  }
  const defaultAsset = streamAssetCache.get(camera) || '';
  const asset = requestUrl.searchParams.get('asset') || defaultAsset;
  if (!ASSET_RE.test(asset) || !/\.(m3u8|ts|m4s|mp4|aac)$/i.test(asset)) {
    sendRegionalJson(res, 400, { error: 'Parameter stream HLS Pasuruan tidak valid.' });
    return;
  }
  if (!defaultAsset) {
    sendRegionalJson(res, 404, { error: 'Kamera Pasuruan tidak ditemukan.' });
    return;
  }
  const assetStem = defaultAsset.replace(/\.m3u8$/i, '');
  if (asset !== defaultAsset && asset !== 'gap.mp4' && !asset.startsWith(assetStem)) {
    sendRegionalJson(res, 404, { error: 'Asset stream Pasuruan tidak diizinkan.' });
    return;
  }
  const target = new URL(`${STREAM_PATH_PREFIX}${asset}`, streamBase);
  const headers = regionalHeaders(REGIONAL_CCTV_USER_AGENT, { Accept: '*/*' });
  if (req.headers.range) headers.Range = String(req.headers.range);
  const startedAt = Date.now();
  let result: UpstreamResult;
  try {
    result = await requestHls(target, headers);
  } catch (error) {
    logPasuruan('error', {
      event: 'stream-error',
      requestId,
      camera,
      asset,
      durationMs: Date.now() - startedAt,
      error: redactLogMessage((error as Error).message),
    });
    noteStreamUnreachable('pasuruan', camera);
    sendStreamGatewayError(res, `Proxy HLS Pasuruan gagal: ${(error as Error).message}`);
    return;
  }
  const { response, finalUrl } = result;
  logPasuruan('info', {
    event: 'stream-response',
    requestId,
    camera,
    asset,
    status: response.statusCode || 0,
    durationMs: Date.now() - startedAt,
  });
  const status = response.statusCode || 502;
  if (status < 200 || status >= 300) {
    response.resume();
    noteUpstreamStatus('pasuruan', camera, status);
    sendUpstreamStreamError(res, status, `HLS Pasuruan membalas HTTP ${status}.`, { upstreamStatus: status });
    return;
  }
  noteStreamHealthy('pasuruan', camera);
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  if (asset.toLowerCase().endsWith('.m3u8') || contentType.includes('mpegurl')) {
    try {
      const text = await readIncomingText(response, REGIONAL_MAX_PLAYLIST_BYTES, 'Manifest HLS Pasuruan');
      if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Manifest HLS Pasuruan tidak valid.');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.end(rewritePlaylist(text, finalUrl, camera));
    } catch (error) {
      if (!res.headersSent) sendRegionalJson(res, 502, { error: (error as Error).message });
    }
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', contentType || 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  for (const header of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = response.headers[header];
    if (value) res.setHeader(header, value);
  }
  pipeIncoming(response, res);
}

export async function handlePasuruan(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setRegionalGetCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendRegionalJson(res, 405, { error: 'Method Pasuruan tidak valid.' });
    return;
  }
  const requestUrl = new URL(req.url || '', 'http://localhost');
  const mode = requestUrl.searchParams.get('mode') || 'list';
  const requestId = String(res.getHeader('X-Request-Id') || 'unknown');
  if (mode === 'list') {
    try {
      const cameras = await getPasuruanCameras(requestUrl.searchParams.get('refresh') === '1');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=900');
      res.setHeader('X-Lensamas-Data', lastListWasStale ? 'stale' : 'fresh');
      res.setHeader('X-Lensamas-Stale', lastListWasStale ? '1' : '0');
      res.end(JSON.stringify({ data: markOfflineCameras('pasuruan', cameras), source: 'pasuruan' }));
    } catch (error) {
      sendDegradedList(res, 'pasuruan', listCache?.cameras || [], (error as Error).message);
    }
    return;
  }
  if (mode === 'hls') {
    await handleHls(req, res, requestUrl, requestId);
    return;
  }
  sendRegionalJson(res, 400, { error: 'Mode Pasuruan tidak valid.' });
}
