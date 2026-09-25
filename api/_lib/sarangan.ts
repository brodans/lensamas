import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import { MAGETAN_ALLOWED_HOSTS, MAGETAN_LIST_URL } from './config.js';

/**
 * Utilitas bersama untuk integrasi CCTV Kabupaten Magetan (sumber publik:
 * https://cctv.saranganvision.com/).
 *
 * Halaman sumber adalah HTML statis yang memuat sejumlah anchor `.cctv-link`
 * dengan atribut data-latitude, data-longitude, data-name, dan data-url.
 * Stream memakai HLS (file.m3u8) pada host `saranganvision.my.id` di port
 * non-standar (842/845/847/850). Sertifikat TLS host tersebut KEDALUWARSA,
 * sehingga seluruh permintaan server-side wajib memakai
 * `rejectUnauthorized: false`; browser tidak dapat memutar langsung, maka
 * disediakan proxy same-origin (`/api/sarangan-stream`).
 *
 * Deteksi offline dilakukan dengan dua mekanisme:
 *  1. Probe reachability: manifest harus membalas 2xx dan memuat `#EXTM3U`
 *     serta `#EXTINF`. Gagal/TLS error/timeout -> offline.
 *  2. Deteksi stream beku (frozen): `#EXT-X-MEDIA-SEQUENCE` dibandingkan
 *     antar polling. Bila tidak bergerak setelah jeda >= 8 detik -> offline.
 */

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });

const SARANGAN_LIST_URL = MAGETAN_LIST_URL;

export const SARANGAN_ALLOWED_HOSTS = MAGETAN_ALLOWED_HOSTS;

export interface RawSaranganCamera {
  name: string;
  latitude: number;
  longitude: number;
  /** URL m3u8 absolut yang sudah dinormalisasi. */
  streamUrl: string;
  port: string;
  streamName: string;
}

export interface SaranganCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: 'online' | 'offline' | 'unknown';
  source: 'magetan';
  protocol: 'hls';
  /** URL proxy same-origin yang dikonsumsi hls.js di browser. */
  streamUrl: string;
  sourceCode: string;
}

/** Entitas HTML umum yang perlu didekode dari halaman sumber. */
function decodeHtml(input: string): string {
  return String(input || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Menormalkan URL stream: mendekode entitas, mengganti pemisah path Windows
 * (`\`) menjadi `/`, dan memastikan skema http(s) absolut.
 */
function normalizeStreamUrl(raw: string): string {
  const decoded = decodeHtml(raw).replace(/\\/g, '/');
  if (!/^https?:\/\//i.test(decoded)) return '';
  return decoded;
}

function readAttr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return match ? match[1] : '';
}

/**
 * Mengekstrak seluruh kamera dari HTML halaman sumber Sarangan Vision.
 * Atribut dapat tersebar pada beberapa baris, sehingga regex anchor memakai
 * `[^>]*` (tidak melewati `>` pada tag yang sama).
 */
function parseSaranganCameras(html: string): RawSaranganCamera[] {
  const out: RawSaranganCamera[] = [];
  const tags = html.match(/<a\b[^>]*class="cctv-link"[^>]*>/gi) || [];

  for (const tag of tags) {
    const rawUrl = readAttr(tag, 'data-url');
    const streamUrl = normalizeStreamUrl(rawUrl);
    if (!streamUrl) continue;

    let port = '';
    let streamName = '';
    try {
      const parsed = new URL(streamUrl);
      if (!SARANGAN_ALLOWED_HOSTS.has(parsed.hostname)) continue;
      port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      const segments = parsed.pathname.split('/').filter(Boolean);
      streamName = segments[0] || '';
    } catch {
      continue;
    }

    const lat = Number(readAttr(tag, 'data-latitude'));
    const lng = Number(readAttr(tag, 'data-longitude'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const rawName = readAttr(tag, 'data-name');
    out.push({
      name: rawName ? decodeHtml(rawName) : `CCTV ${streamName || port}`,
      latitude: Number(lat.toFixed(6)),
      longitude: Number(lng.toFixed(6)),
      streamUrl,
      port,
      streamName,
    });
  }

  return out;
}

interface TextResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** GET teks via HTTPS dengan toleransi sertifikat kedaluwarsa. */
function httpsGetText(target: string, timeoutMs = 6000): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        rejectUnauthorized: false,
        agent: httpsAgent,
        headers: {
          'User-Agent': 'lensamas-proxy/1.0',
          Accept: '*/*',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Timeout koneksi ke sumber Magetan')));
    req.on('error', reject);
    req.end();
  });
}

interface HttpsStreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  stream: IncomingMessage;
}

/** Membuka stream respons HTTPS (tanpa buffering) untuk proxy segmen/playlist. */
export function httpsStream(
  target: string,
  timeoutMs = 15000,
  extraHeaders: Record<string, string> = {}
): Promise<HttpsStreamResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        rejectUnauthorized: false,
        agent: httpsAgent,
        headers: {
          'User-Agent': 'lensamas-proxy/1.0',
          Accept: '*/*',
          ...extraHeaders,
        },
        timeout: timeoutMs,
      },
      (res) => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          stream: res,
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Timeout koneksi ke sumber Magetan')));
    req.on('error', reject);
    req.end();
  });
}

/** URL proxy same-origin untuk direwrite ke dalam manifest m3u8. */
const streamTargets = new Map<string, string>();

function cameraCode(item: Pick<RawSaranganCamera, 'port' | 'streamName'>): string {
  return `${item.port}/${item.streamName || 'cam'}`;
}

function defaultAsset(streamUrl: string): string {
  try {
    return new URL(streamUrl).pathname.split('/').filter(Boolean).pop() || 'file.m3u8';
  } catch {
    return 'file.m3u8';
  }
}

/** URL proxy same-origin tanpa membawa URL upstream/query token ke browser. */
export function toProxyUrl(camera: string, asset: string): string {
  return `/api/sarangan-stream?${new URLSearchParams({ camera, asset }).toString()}`;
}

export async function resolveSaranganStreamUrl(camera: string): Promise<string | undefined> {
  const cached = streamTargets.get(camera);
  if (cached) return cached;
  const raw = await getRawSaranganCameras();
  const item = raw.find((candidate) => cameraCode(candidate) === camera);
  if (!item) return undefined;
  streamTargets.set(camera, item.streamUrl);
  return item.streamUrl;
}

// ── Deteksi status online/offline ──────────────────────────────────────────────

/** Jeda minimum antar sonding sebelum kesimpulan "stream beku" diambil. */
const FROZEN_MIN_INTERVAL_MS = 8000;

interface ProbeEntry {
  seq: number | null;
  ts: number;
  manifestOk: boolean;
}

const probeCache = new Map<string, ProbeEntry>();

function parseMediaSequence(body: string): number | null {
  const match = body.match(/#EXT-X-MEDIA-SEQUENCE\s*:\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

/**
 * Menentukan status satu stream Magetan.
 * - Manifest valid (2xx + EXT M3U + EXTINF) -> online.
 * - Manifest valid tetapi MEDIA-SEQUENCE tidak bergerak setelah >= 8 dtk -> offline (beku).
 * - Manifest tidak valid / TLS / timeout / HTTP error -> offline.
 */
export async function probeStreamStatus(
  url: string,
  timeoutMs = 3000
): Promise<'online' | 'offline'> {
  const now = Date.now();
  const cached = probeCache.get(url);
  if (cached && now - cached.ts < 20_000) {
    return cached.manifestOk ? 'online' : 'offline';
  }
  try {
    const res = await httpsGetText(url, timeoutMs);
    const body = res.body || '';
    const manifestOk =
      res.status >= 200 &&
      res.status < 400 &&
      body.includes('#EXTM3U') &&
      body.includes('#EXTINF');

    if (!manifestOk) {
      probeCache.set(url, { seq: null, ts: now, manifestOk: false });
      return 'offline';
    }

    const seq = parseMediaSequence(body);
    const prev = probeCache.get(url);
    let status: 'online' | 'offline' = 'online';

    if (
      prev &&
      prev.manifestOk &&
      prev.seq !== null &&
      seq !== null &&
      prev.seq === seq &&
      now - prev.ts >= FROZEN_MIN_INTERVAL_MS
    ) {
      status = 'offline'; // sequence beku -> stream macet
    }

    probeCache.set(url, { seq, ts: now, manifestOk: true });
    return status;
  } catch {
    probeCache.set(url, { seq: null, ts: now, manifestOk: false });
    return 'offline';
  }
}

/** Menjalankan fungsi async pada array dengan batas konkurensi. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = new Array(workerCount).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Cache daftar kamera (TTL 6 jam) ────────────────────────────────────────────

const LIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let listCache: { ts: number; items: RawSaranganCamera[] } | null = null;
let listInFlight: Promise<RawSaranganCamera[]> | null = null;

/** Mengambil daftar mentah kamera Magetan, dengan cache in-memory 6 jam. */
export function getRawSaranganCameras(forceRefresh = false): Promise<RawSaranganCamera[]> {
  const now = Date.now();
  if (!forceRefresh && listCache && now - listCache.ts < LIST_CACHE_TTL_MS) {
    return Promise.resolve(listCache.items);
  }
  if (listInFlight) return listInFlight;

  listInFlight = httpsGetText(SARANGAN_LIST_URL, 12000)
    .then((res) => {
      if (res.status >= 400) {
        if (listCache) return listCache.items;
        throw new Error(`Sumber CCTV Sarangan membalas HTTP ${res.status}`);
      }
      const items = parseSaranganCameras(res.body);
      if (items.length === 0) {
        if (listCache) return listCache.items;
        throw new Error('Tidak ada CCTV Magetan yang dapat diparsing dari halaman sumber.');
      }
      listCache = { ts: Date.now(), items };
      return items;
    })
    .finally(() => {
      listInFlight = null;
    });
  return listInFlight;
}

/** Memetakan kamera mentah + status hasil probe ke bentuk `Camera` aplikasi. */
export function toSaranganCameras(
  raw: RawSaranganCamera[],
  statuses: Array<'online' | 'offline' | 'unknown'>
): SaranganCamera[] {
  return raw.map((item, index) => {
    const streamName = item.streamName || 'cam';
    const code = cameraCode(item);
    streamTargets.set(code, item.streamUrl);
    return {
      slug: `magetan-${item.port}-${streamName}`,
      name: item.name,
      location: 'Kabupaten Magetan',
      latitude: item.latitude,
      longitude: item.longitude,
      status: statuses[index] || 'unknown',
      source: 'magetan',
      protocol: 'hls',
      streamUrl: toProxyUrl(code, defaultAsset(item.streamUrl)),
      sourceCode: code,
    };
  });
}
