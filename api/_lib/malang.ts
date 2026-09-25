import type { IncomingMessage, ServerResponse } from 'node:http';
import * as https from 'node:https';

import malangFallback from './malang-fallback.json' with { type: 'json' };
import {
  MALANG_API_URL,
  MALANG_DISTRICT_ID,
  MALANG_ORIGIN,
  MALANG_PAGE_URL,
} from './config.js';

import {
  sendDegradedList,
} from './regional-hls.js';
import {
  markOfflineCameras,
} from './stream-circuit.js';

type MalangCamera = Record<string, unknown>;
type CameraStatus = 'online' | 'offline';

export interface MalangNormalizedCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: CameraStatus;
  source: 'malang';
  protocol: 'hls';
  streamUrl: string;
  sourceCode: string;
  district: string;
}

interface MalangResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface MalangListPayload {
  msg_detail?: {
    list_data?: MalangCamera[];
  };
}

interface CacheEntry {
  expiresAt: number;
  cameras: MalangNormalizedCamera[];
}

const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

// Snapshot resmi tetap dibundel agar metadata tetap tersedia di Vercel ketika
// WAF upstream menolak egress datacenter. Playback memakai fallback URL dari browser.
let listCache: CacheEntry | null = {
  expiresAt: 0,
  cameras: malangFallback.data as MalangNormalizedCamera[],
};
let inFlightRequest: Promise<MalangNormalizedCamera[]> | null = null;
let lastListWasFallback = true;

const malangAgent = new https.Agent({
  keepAlive: false,
  // The official portal currently exposes an incomplete certificate chain.
  // This exception is intentionally scoped to its known HTTPS host.
  rejectUnauthorized: false,
  maxSockets: 4,
});

function requestMalang(
  url: string,
  options: https.RequestOptions,
  body = ''
): Promise<MalangResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, response?: { statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else if (response) resolve(response);
    };

    const request = https.request(
      url,
      {
        ...options,
        agent: malangAgent,
        headers: { Connection: 'close', ...options.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_METADATA_BYTES) {
            response.destroy();
            finish(new Error('Respons metadata Malang terlalu besar.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => finish(undefined, {
          statusCode: response.statusCode || 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
        response.on('aborted', () => finish(new Error('Respons metadata Malang terputus.')));
        response.on('error', (error) => finish(error));
      }
    );

    request.on('error', (error) => finish(error));
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('Permintaan ke sumber CCTV Malang habis waktu.'));
    });
    if (body) request.write(body);
    request.end();
  });
}

async function requestMalangWithRetry(
  url: string,
  options: https.RequestOptions,
  body = '',
  attempts = 2
): Promise<MalangResponse> {
  let lastError: unknown;
  let lastResponse: MalangResponse | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await requestMalang(url, options, body);
      lastResponse = response;
      if (response.statusCode !== 429 && response.statusCode < 500) return response;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error
    ? lastError
    : new Error('Permintaan ke sumber CCTV Malang gagal.');
}

function getCookie(headers: Record<string, string | string[] | undefined>): string | undefined {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return undefined;
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  const cookie = values.map((value) => value.split(';')[0]).join('; ');
  return cookie || undefined;
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function multipartField(name: string, value: string): { boundary: string; body: string } {
  const boundary = `----LensamasMalang${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return {
    boundary,
    body:
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n` +
      `--${boundary}--\r\n`,
  };
}

function urlEncodedField(name: string, value: string): string {
  return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
}

function normalizeStatus(value: unknown): CameraStatus {
  const normalized = String(value ?? '1').trim().toLowerCase();
  return ['0', 'false', 'offline', 'inactive', 'disabled'].includes(normalized)
    ? 'offline'
    : 'online';
}

function cleanText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/\s+/g, ' ').replace(/,\s*,/g, ',').trim();
  return cleaned || fallback;
}

function parseCoordinate(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!text) return null;
  const coordinate = Number(text);
  return Number.isFinite(coordinate) ? coordinate : null;
}

/** Normalisasi payload resmi menjadi kamera yang siap dipakai aplikasi. */
export function normalizeMalangCameras(raw: MalangCamera[]): MalangNormalizedCamera[] {
  const cameras: MalangNormalizedCamera[] = [];
  const seen = new Set<string>();
  for (const camera of raw) {
    const streamId = typeof camera.stream_id === 'string' || typeof camera.stream_id === 'number'
      ? String(camera.stream_id).trim()
      : '';
    if (!/^\d{1,40}$/.test(streamId) || seen.has(streamId)) continue;

    const latitude = parseCoordinate(camera.latitude);
    const longitude = parseCoordinate(camera.longitude);
    if (latitude === null || longitude === null) continue;

    const district = cleanText(camera.nama_kecamatan, 'Kota Malang');
    const address = cleanText(camera.address, district);
    const proxyUrl = `/api/hls-proxy?source=malang&streamId=${encodeURIComponent(streamId)}&asset=index.m3u8`;

    seen.add(streamId);
    cameras.push({
      slug: `malang-${streamId}`,
      name: cleanText(camera.name, `CCTV ${district}`),
      location: address,
      latitude,
      longitude,
      status: normalizeStatus(camera.status),
      source: 'malang',
      protocol: 'hls',
      streamUrl: proxyUrl,
      sourceCode: streamId,
      district,
    });
  }

  return cameras;
}

async function fetchMalangCameras(): Promise<MalangNormalizedCamera[]> {
  const page = await requestMalangWithRetry(MALANG_PAGE_URL, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': USER_AGENT,
    },
  });
  if (page.statusCode < 200 || page.statusCode >= 300) {
    throw new Error(`Halaman resmi Malang membalas HTTP ${page.statusCode}.`);
  }

  const cookie = getCookie(page.headers);
  const commonHeaders: Record<string, string> = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    Origin: MALANG_ORIGIN,
    Referer: MALANG_PAGE_URL,
    'User-Agent': USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    ...(cookie ? { Cookie: cookie } : {}),
  };

  // Samakan dengan FormData yang digunakan halaman resmi. Fallback
  // URL-encoded menjaga kompatibilitas bila upstream mengubah parser.
  const multipart = multipartField('m_kecamatan_id', MALANG_DISTRICT_ID);
  let response = await requestMalangWithRetry(MALANG_API_URL, {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
      'Content-Length': Buffer.byteLength(multipart.body),
    },
  }, multipart.body);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const encoded = urlEncodedField('m_kecamatan_id', MALANG_DISTRICT_ID);
    response = await requestMalangWithRetry(MALANG_API_URL, {
      method: 'POST',
      headers: {
        ...commonHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(encoded),
      },
    }, encoded, 1);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`API resmi Malang membalas HTTP ${response.statusCode}.`);
  }

  let payload: MalangListPayload;
  try {
    payload = JSON.parse(response.body.toString('utf8')) as MalangListPayload;
  } catch {
    throw new Error('Respons API Malang bukan JSON yang valid.');
  }

  const raw = payload.msg_detail?.list_data;
  if (!Array.isArray(raw)) throw new Error('API Malang tidak berisi daftar kamera.');
  const cameras = normalizeMalangCameras(raw);
  if (cameras.length === 0) throw new Error('API Malang tidak memuat kamera yang valid.');
  return cameras;
}

async function getCamerasWithCache(): Promise<MalangNormalizedCamera[]> {
  const now = Date.now();
  if (listCache && listCache.expiresAt > now) return listCache.cameras;
  if (inFlightRequest) return inFlightRequest;

  inFlightRequest = fetchMalangCameras()
    .then((cameras) => {
      listCache = { expiresAt: Date.now() + LIST_CACHE_TTL_MS, cameras };
      lastListWasFallback = false;
      return cameras;
    })
    .catch((error) => {
      if (listCache) {
        listCache.expiresAt = Date.now() + FALLBACK_CACHE_TTL_MS;
        lastListWasFallback = true;
        return listCache.cameras;
      }
      throw error;
    })
    .finally(() => {
      inFlightRequest = null;
    });

  return inFlightRequest;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Allow', 'GET, OPTIONS');
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  try {
    const cameras = await getCamerasWithCache();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600');
    res.setHeader('X-Lensamas-Data', lastListWasFallback ? 'stale' : 'fresh');
    res.end(JSON.stringify({ data: markOfflineCameras('malang', cameras), source: 'malang' }));
  } catch (error) {
    res.statusCode = 502;
    sendDegradedList(res, 'malang', malangFallback.data, (error as Error).message);
  }
}
