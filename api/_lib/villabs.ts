import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import * as https from 'node:https';
import {
  MADIUN_API_URL,
  MADIUN_ORIGIN,
  MADIUN_PRIMARY_API_URL,
  MADIUN_PRIMARY_TLS_HOST,
  MADIUN_PRIMARY_USER_AGENT,
  MADIUN_STREAM_BASE,
} from './config.js';
import { redactLogMessage, shouldWriteProviderLog } from './request-log.js';

import {
  sendDegradedList,
} from './regional-hls.js';
import { snapshotCameras } from './list-snapshot.js';

/**
 * Proxy & normalizer untuk CCTV Kota Madiun.
 *
 * Sumber utama adalah portal resmi pada IP yang dikonfigurasi
 * (https://103.149.120.205/cctv/). Karena sertifikat IP memakai nama
 * cctv.villabs.id, request primary tetap melakukan verifikasi TLS dengan
 * SNI/Host yang dikonfigurasi. Villabs menjadi fallback otomatis.
 *
 * Stream memakai protokol JSMPEG lewat WebSocket (dikonsumsi langsung browser,
 * karena WebSocket tidak dapat diproksi di serverless):
 *   wss://cctv.villabs.id/streamer-jsmpeg/streamer/{code}
 *
 * Deteksi status default hanya memakai flag ping sebagai metadata pro-forma;
 * probe WebSocket tambahan hanya dijalankan ketika request meminta `probe=1`.
 */

const VILLABS_API = MADIUN_API_URL;
const VILLABS_ORIGIN = MADIUN_ORIGIN;
const PRIMARY_API = new URL(MADIUN_PRIMARY_API_URL);

interface JunctionMeta {
  lat: number;
  lng: number;
  label: string;
}

/** Titik simpang CCTV Kota Madiun. */
const JUNCTIONS: Record<string, JunctionMeta> = {
  rejoagung: {
    lat: -7.60275,
    lng: 111.53347,
    label: 'Simpang 4 Rejoagung (Ring Road Utara x Yos Sudarso), Kota Madiun',
  },
  tean: {
    lat: -7.65776,
    lng: 111.526868,
    label: "Simpang 4 Te'an (Raya Madiun-Ponorogo x D.I. Panjaitan), Kota Madiun",
  },
  serayu: {
    lat: -7.6471,
    lng: 111.5247,
    label: 'Simpang 4 Serayu (D.I. Panjaitan x Serayu), Kota Madiun',
  },
  klegen: {
    lat: -7.63265,
    lng: 111.532948,
    label: 'Simpang 4 Klegen (Setiabudi x Thamrin), Kota Madiun',
  },
  gading: {
    lat: -7.6236,
    lng: 111.5015,
    label: 'Simpang 3 Gading (Ring Road Utara x Urip Sumoharjo), Kota Madiun',
  },
  tugu: {
    lat: -7.6304729,
    lng: 111.5194338,
    label: 'Simpang 4 Tugu 0 Km (Cokroaminoto x P. Sudirman), Kota Madiun',
  },
  proliman: {
    lat: -7.624117,
    lng: 111.533083,
    label: 'Simpang 5 Tugu Pendekar (Diponegoro x Thamrin), Kota Madiun',
  },
  pga: {
    lat: -7.639915,
    lng: 111.532524,
    label: 'Simpang 4 PGA (M.T. Haryono), Kota Madiun',
  },
  fatur: {
    lat: -7.641064,
    lng: 111.536595,
    label: 'Simpang 4 Fatur (Letkol Suwarno), Kota Madiun',
  },
  merak: {
    lat: -7.648179,
    lng: 111.518578,
    label: 'Simpang 3 Merak (Soekarno-Hatta x Merak), Kota Madiun',
  },
  seleko: {
    lat: -7.639452,
    lng: 111.517602,
    label: 'Simpang 4 Seleko (Trunojoyo x Agus Salim), Kota Madiun',
  },
  agussalim: {
    lat: -7.634493,
    lng: 111.517239,
    label: 'Simpang 4 Agus Salim, Kota Madiun',
  },
  pandan: {
    lat: -7.628352,
    lng: 111.517712,
    label: 'Simpang 4 Pandan (Alun-alun Selatan), Kota Madiun',
  },
  '501': {
    lat: -7.6269685,
    lng: 111.5034637,
    label: 'Simpang 4 501 (Sido Makmur x Urip Sumoharjo), Kota Madiun',
  },
};

/**
 * Menentukan grup simpang dari kode kamera Villabs.
 * Contoh: "rejoagung2" -> rejoagung, "vga1" -> pga (alias), "501A3" -> 501.
 */
export function resolveGroup(code: string): string | null {
  const c = (code || '').toLowerCase().trim();

  const numeric = c.match(/^(\d+)/);
  if (numeric && JUNCTIONS[numeric[1]]) return numeric[1];

  const alpha = c.match(/^([a-z]+)/);
  if (alpha) {
    const key = alpha[1] === 'vga' ? 'pga' : alpha[1];
    if (JUNCTIONS[key]) return key;
  }
  return null;
}

/** Offset kecil agar kamera pada simpang yang sama tidak saling menumpuk di peta. */
function spreadOffset(index: number): { dLat: number; dLng: number } {
  const radius = 0.00045; // sekitar 50 m
  const angle = ((index % 6) * 60 + 30) * (Math.PI / 180);
  return { dLat: radius * Math.cos(angle), dLng: radius * Math.sin(angle) };
}

interface VillabsCamera {
  id: number;
  name: string;
  code: string;
  server_id?: number;
  ping?: boolean;
  thumbnail_url?: string;
}

export type MadiunStatus = 'online' | 'offline';

export interface MadiunCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: MadiunStatus;
  source: 'madiun';
  protocol: 'jsmpeg' | 'hls' | 'flv' | 'mjpeg' | 'go2rtc';
  streamUrl: string;
  thumbUrl?: string;
  code: string;
  group?: string;
}

const VILLABS_STREAM_BASE = MADIUN_STREAM_BASE.replace(/\/+$/, '');

/** URL WebSocket streamer dibuat dari base tepercaya, bukan dari field upstream. */
function streamUrlFor(cam: VillabsCamera): string {
  return `${VILLABS_STREAM_BASE}/${encodeURIComponent(cam.code)}`;
}

function safeThumbnail(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value, VILLABS_ORIGIN);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeVillabsCameras(
  raw: VillabsCamera[],
  statuses?: Map<string, MadiunStatus>
): MadiunCamera[] {
  const groupCount: Record<string, number> = {};

  return raw
    .filter((cam) => cam && cam.code)
    .map((cam) => {
      const group = resolveGroup(cam.code);
      const meta = group ? JUNCTIONS[group] : null;

      const idx = group ? (groupCount[group] = (groupCount[group] ?? 0) + 1) - 1 : 0;
      const { dLat, dLng } = meta ? spreadOffset(idx) : { dLat: 0, dLng: 0 };

      // Status sebenarnya dari hasil probe; jika belum tersedia, pakai flag `ping`.
      const status: MadiunStatus =
        statuses?.get(cam.code) ?? (cam.ping === false ? 'offline' : 'online');

      return {
        slug: `villabs-${cam.code}`,
        name: cam.name || `CCTV ${cam.code}`,
        location: meta ? meta.label : 'Kota Madiun',
        latitude: meta ? Number((meta.lat + dLat).toFixed(6)) : -7.629,
        longitude: meta ? Number((meta.lng + dLng).toFixed(6)) : 111.523,
        status,
        source: 'madiun' as const,
        protocol: 'jsmpeg' as const,
        streamUrl: streamUrlFor(cam),
        thumbUrl: safeThumbnail(cam.thumbnail_url),
        code: cam.code,
        group: group ?? undefined,
      };
    });
}

// ── Deteksi liveness stream (WebSocket handshake + byte frame pertama) ─────────

const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 3000;
const PROBE_HARD_CAP_MS = 8000;
const PROBE_CACHE_TTL_MS = 45_000;

interface ProbeEntry {
  status: MadiunStatus;
  ts: number;
}

const livenessCache = new Map<string, ProbeEntry>();

/**
 * Menentukan apakah sebuah streamer JSMPEG benar-benar mengalirkan data.
 *
 * Prosedur: kirim handshake "Upgrade: websocket". Bila server membalas 101
 * (Switching Protocols) DAN mengirim byte pertama (frame JSMPEG) dalam batas
 * waktu -> online. Bila 101 tanpa byte, atau error/timeout -> offline.
 *
 * Pendekatan ini memakai `node:https` murni (tanpa dependensi WebSocket) dan
 * memanfaatkan fakta bahwa produser JSMPEG mengirim frame secara kontinu,
 * sementara kanal mati membalas 101 lalu diam.
 */
export function probeStreamer(rawUrl: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<MadiunStatus> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (status: MadiunStatus): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        req.destroy();
      } catch {
        /* noop */
      }
      resolve(status);
    };

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      resolve('offline');
      return;
    }

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          Origin: VILLABS_ORIGIN,
          'User-Agent': 'lensamas-proxy/1.0',
        },
        timeout: timeoutMs,
      },
      () => {
        // Respons non-101 -> bukan upgrade WebSocket -> offline.
        finish('offline');
      }
    );

    req.on('upgrade', (_res, socket) => {
      // 101 diterima; tunggu byte frame pertama dari produser.
      socket.once('data', () => {
        try {
          socket.destroy();
        } catch {
          /* noop */
        }
        finish('online');
      });
      socket.once('error', () => finish('offline'));
      socket.once('close', () => finish('offline'));
    });

    req.on('timeout', () => finish('offline'));
    req.on('error', () => finish('offline'));

    timer = setTimeout(() => finish('offline'), timeoutMs);
    req.end();
  });
}

/** Resolusi status untuk sekumpulan kamera dengan cache + batas konkurensi. */
async function resolveLiveness(cams: VillabsCamera[]): Promise<Map<string, MadiunStatus>> {
  const now = Date.now();
  const result = new Map<string, MadiunStatus>();
  const pending: Array<{ code: string; url: string }> = [];

  for (const cam of cams) {
    if (!cam?.code) continue;
    const cached = livenessCache.get(cam.code);
    if (cached && now - cached.ts < PROBE_CACHE_TTL_MS) {
      result.set(cam.code, cached.status);
    } else {
      pending.push({ code: cam.code, url: streamUrlFor(cam) });
    }
  }

  if (pending.length === 0) return result;

  let cursor = 0;
  const workerCount = Math.min(PROBE_CONCURRENCY, pending.length);
  const workers = new Array(workerCount).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      const { code, url } = pending[index];
      const status = await probeStreamer(url, PROBE_TIMEOUT_MS);
      livenessCache.set(code, { status, ts: Date.now() });
      result.set(code, status);
    }
  });

  await Promise.all(workers);
  return result;
}

/** Membatasi total waktu probe agar respons tetap cepat (sisanya pakai `ping`). */
function withHardCap(
  probe: Promise<Map<string, MadiunStatus>>,
  capMs: number
): Promise<Map<string, MadiunStatus>> {
  return Promise.race([
    probe,
    new Promise<Map<string, MadiunStatus>>((resolve) => {
      setTimeout(() => resolve(new Map()), capMs);
    }),
  ]);
}

type UpstreamKind = 'primary' | 'villabs-fallback';

interface JsonResponse {
  status: number;
  body: string;
  retryAfter: string | null;
}

interface ListResult {
  cameras: VillabsCamera[];
  upstream: UpstreamKind;
  stale: boolean;
}

interface ListCacheEntry extends ListResult {
  expiresAt: number;
}

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 50;
const PAGE_SIZE = 10;
const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const PRIMARY_TLS_HOST = MADIUN_PRIMARY_TLS_HOST || PRIMARY_API.hostname;

let listCache: ListCacheEntry | null = null;
let listInFlight: Promise<ListResult> | null = null;

function sanitizeCamera(value: unknown): VillabsCamera | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
  const code = typeof raw.code === 'string' ? raw.code.trim() : '';
  if (!Number.isFinite(id) || !code) return null;
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : `CCTV ${code}`,
    code,
    server_id: typeof raw.server_id === 'number' ? raw.server_id : undefined,
    ping: raw.ping === true,
    thumbnail_url: typeof raw.thumbnail_url === 'string' ? raw.thumbnail_url : undefined,
  };
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Lensamas-Source, X-Lensamas-Fallback, X-Lensamas-Stale');
}

function retryAfter(headers: IncomingHttpHeaders): string | null {
  const value = headers['retry-after'];
  return Array.isArray(value) ? value[0] || null : value || null;
}

function requestJson(target: URL, kind: UpstreamKind): Promise<JsonResponse> {
  if (kind === 'primary' && target.protocol !== 'https:') {
    return Promise.reject(new Error('MADIUN_PRIMARY_API_URL harus menggunakan HTTPS.'));
  }

  return new Promise((resolve, reject) => {
    const isPrimary = kind === 'primary';
    const requestHost = isPrimary ? PRIMARY_TLS_HOST : target.host;
    const options: https.RequestOptions = {
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      rejectUnauthorized: true,
      headers: {
        Host: requestHost,
        Accept: 'application/json',
        'User-Agent': isPrimary ? MADIUN_PRIMARY_USER_AGENT : 'lensamas-proxy/1.0',
        Connection: 'close',
      },
    };
    if (isPrimary) options.servername = PRIMARY_TLS_HOST;

    const request = https.request(options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_JSON_BYTES) {
          response.destroy();
          reject(new Error('Respons API Madiun terlalu besar.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
          retryAfter: retryAfter(response.headers),
        });
      });
      response.on('aborted', () => reject(new Error('Respons API Madiun terputus.')));
      response.on('error', reject);
    });
    request.setTimeout(12_000, () => request.destroy(new Error('Permintaan API Madiun habis waktu.')));
    request.on('error', reject);
    request.end();
  });
}

function logMadiun(level: 'info' | 'error', payload: Record<string, unknown>): void {
  if (!shouldWriteProviderLog(level)) return;
  const line = `[lensamas-madiun] ${JSON.stringify(payload)}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

async function fetchCameraPages(kind: UpstreamKind, requestId: string): Promise<VillabsCamera[]> {
  const base = kind === 'primary' ? PRIMARY_API : new URL(VILLABS_API);
  const cameras: VillabsCamera[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const target = new URL(base.toString());
    target.searchParams.set('page', String(page));
    const startedAt = Date.now();
    let response: JsonResponse;
    try {
      response = await requestJson(target, kind);
    } catch (error) {
      logMadiun('error', {
        event: 'upstream-error',
        requestId,
        source: kind,
        page,
        durationMs: Date.now() - startedAt,
        error: redactLogMessage((error as Error).message),
      });
      throw error;
    }
    logMadiun('info', {
      event: 'upstream-response',
      requestId,
      source: kind,
      page,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    if (response.status < 200 || response.status >= 300) {
      const retry = response.retryAfter ? `, retry-after=${response.retryAfter}` : '';
      throw new Error(`API Madiun ${kind} membalas HTTP ${response.status}${retry}.`);
    }

    let json: { success?: boolean; data?: unknown };
    try {
      json = JSON.parse(response.body) as { success?: boolean; data?: unknown };
    } catch {
      throw new Error(`Respons API Madiun ${kind} bukan JSON yang valid.`);
    }
    if (!Array.isArray(json.data)) {
      throw new Error(`Respons API Madiun ${kind} tidak berisi data kamera.`);
    }
    if (json.data.length === 0) break;

    for (const value of json.data) {
      const camera = sanitizeCamera(value);
      if (!camera) continue;
      const key = String(camera.id || camera.code);
      if (seen.has(key)) continue;
      seen.add(key);
      cameras.push(camera);
    }
    if (json.data.length < PAGE_SIZE) break;
  }

  if (cameras.length === 0) throw new Error(`API Madiun ${kind} tidak memuat kamera.`);
  return cameras;
}

async function loadMadiunCameras(forceRefresh: boolean, requestId: string): Promise<ListResult> {
  const now = Date.now();
  if (!forceRefresh && listCache && listCache.expiresAt > now) {
    return listCache;
  }
  if (listInFlight) return listInFlight;

  listInFlight = (async (): Promise<ListResult> => {
    try {
      const cameras = await fetchCameraPages('primary', requestId);
      const result: ListResult = { cameras, upstream: 'primary', stale: false };
      listCache = { ...result, expiresAt: Date.now() + LIST_CACHE_TTL_MS };
      return result;
    } catch (error) {
      logMadiun('error', {
        event: 'upstream-fallback',
        source: 'madiun-primary',
        requestId,
        error: redactLogMessage((error as Error).message),
        site: 'primary',
      });
    }

    try {
      const cameras = await fetchCameraPages('villabs-fallback', requestId);
      const result: ListResult = { cameras, upstream: 'villabs-fallback', stale: false };
      listCache = { ...result, expiresAt: Date.now() + LIST_CACHE_TTL_MS };
      return result;
    } catch (fallbackError) {
      if (listCache) {
        listCache.expiresAt = Date.now() + LIST_CACHE_TTL_MS;
        return { ...listCache, stale: true };
      }
      throw new Error(`Primary dan fallback Madiun gagal: ${(fallbackError as Error).message}`);
    }
  })().finally(() => {
    listInFlight = null;
  });

  return listInFlight;
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
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  const requestUrl = new URL(req.url || '', 'http://localhost');
  const shouldProbe = requestUrl.searchParams.get('probe') === '1';
  const forceRefresh = requestUrl.searchParams.get('refresh') === '1';

  try {
    const requestId = String(res.getHeader('X-Request-Id') || 'unknown');
    const result = await loadMadiunCameras(forceRefresh, requestId);
    const statuses = shouldProbe
      ? await withHardCap(resolveLiveness(result.cameras), PROBE_HARD_CAP_MS)
      : new Map<string, MadiunStatus>();
    const cameras = normalizeVillabsCameras(result.cameras, statuses);
    const source = result.upstream === 'primary' ? 'madiun-primary' : 'madiun-villabs-fallback';

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=600');
    res.setHeader('X-Lensamas-Source', source);
    res.setHeader('X-Lensamas-Fallback', result.upstream === 'villabs-fallback' ? '1' : '0');
    res.setHeader('X-Lensamas-Stale', result.stale ? '1' : '0');
    res.statusCode = 200;
    res.end(JSON.stringify({
      data: cameras,
      source: 'madiun',
      upstream: result.upstream,
      stale: result.stale,
    }));
  } catch (error) {
    sendDegradedList(res, 'madiun', snapshotCameras('madiun'), (error as Error).message);
  }
}
