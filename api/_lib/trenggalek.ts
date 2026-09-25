import type { IncomingMessage, ServerResponse } from 'node:http';

import trenggalekFallback from './trenggalek-fallback.json' with { type: 'json' };
import {
  TRENGGALEK_GEOTIK_LIST_URL,
  TRENGGALEK_GEOTIK_ORIGIN,
  TRENGGALEK_LIST_URL,
  TRENGGALEK_ORIGIN,
  TRENGGALEK_STREAM_HOST,
} from './config.js';
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

/**
 * Proxy & normalizer untuk CCTV Kabupaten Trenggalek.
 *
 * Sumber utama adalah endpoint GeoJSON publik GEOTIK v2:
 * https://geotik.trenggalekkab.go.id/home/get_cctv
 * Endpoint ini berada di origin Apache yang dapat diakses server dan tidak
 * memerlukan challenge/cookie Cloudflare. Portal TGX lama tetap menjadi
 * fallback lama bila GeoJSON sedang tidak tersedia.
 */

const TGX_LIST_URL = TRENGGALEK_LIST_URL;
const TGX_ORIGIN = TRENGGALEK_ORIGIN;
const GEOTIK_ORIGIN = TRENGGALEK_GEOTIK_ORIGIN;
const STREAM_HOST = TRENGGALEK_STREAM_HOST;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const STREAM_TARGETS = new Map<string, string>();
const STREAM_CODE_RE = /^[A-Za-z0-9_-]{1,120}$/;
const STREAM_ASSET_RE = /^[A-Za-z0-9._~/%-]+$/;

function streamRoot(pathname: string): string {
  const slash = pathname.lastIndexOf('/');
  return slash >= 0 ? pathname.slice(0, slash + 1) : '/';
}

function safeStreamAsset(value: string): boolean {
  return Boolean(value) && STREAM_ASSET_RE.test(value) && !value.includes('..') && !value.includes('\\');
}

function proxyAssetUrl(code: string, asset: string): string {
  return `/api/hls-proxy?${new URLSearchParams({
    source: 'trenggalek',
    mode: 'hls',
    camera: code,
    asset,
  }).toString()}`;
}

function defaultStreamAsset(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname.split('/').filter(Boolean).pop() || 'playlist.m3u8';
  } catch {
    return 'playlist.m3u8';
  }
}

async function resolveStreamTarget(code: string): Promise<string | undefined> {
  const cached = STREAM_TARGETS.get(code);
  if (cached) return cached;
  const raw = await getRawTrenggalekCameras();
  const item = raw.find((camera) => camera.code === code);
  if (!item) return undefined;
  STREAM_TARGETS.set(code, item.streamUrl);
  return item.streamUrl;
}

export interface RawTrenggalekCamera {
  /** Kode stabil dari URL SMIL, mis. `cctv2_pendopo`. */
  code: string;
  name: string;
  streamUrl: string;
  location?: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface TrenggalekCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: 'online' | 'offline';
  source: 'trenggalek';
  protocol: 'hls';
  streamUrl: string;
  sourceCode: string;
}

/** Titik perkiraan untuk kamera lama yang GeoJSON tidak memberi koordinat. */
const COORDINATES: Record<string, { lat: number; lng: number; label: string }> = {
  cctv1_alon2_selatan_timur: { lat: -8.0523, lng: 111.7108, label: 'Alun-Alun Trenggalek (Selatan Timur)' },
  cctv2_pendopo: { lat: -8.0505, lng: 111.7052, label: 'Pendopo Kabupaten Trenggalek' },
  cctv5_pasar_sore: { lat: -8.0462, lng: 111.7121, label: 'Pasar Sore Trenggalek' },
  cctv6_ptsp: { lat: -8.0578, lng: 111.7136, label: 'Dinas PTSP Kabupaten Trenggalek' },
  cctv7_masjid_agung: { lat: -8.0535, lng: 111.7089, label: 'Masjid Agung Trenggalek' },
  cctv8_alon2_selatan: { lat: -8.0538, lng: 111.7087, label: 'Alun-Alun Trenggalek (Selatan)' },
  cctv9_alon2_selatan_barat: { lat: -8.0523, lng: 111.7065, label: 'Alun-Alun Trenggalek (Selatan Barat)' },
  cctv10_pasar_pon: { lat: -8.0555, lng: 111.7035, label: 'Pasar Pon Trenggalek' },
  cctv11_alon2_utara: { lat: -8.0469, lng: 111.7087, label: 'Alun-Alun Trenggalek (Utara)' },
  cctv12_taman_brawijaya: { lat: -8.0560, lng: 111.7020, label: 'Taman Brawijaya Trenggalek' },
  cctv13_pasar_pon_pujasera: { lat: -8.0553, lng: 111.7093, label: 'Pujasera Pasar Pon Trenggalek' },
  cctv14_kecamatan_panggul: { lat: -8.2350, lng: 111.4520, label: 'Taman Balai Kota Panggul' },
  cctv15_jembatan_tamanan: { lat: -8.0580, lng: 111.7230, label: 'Jembatan Tamanan, Kec. Trenggalek' },
  cctv16_jembatan_ngasinan_timur: { lat: -8.0645, lng: 111.7110, label: 'Jembatan Ngasinan (Timur), Sungai Ngasinan' },
  cctv17_jembatan_ngasinan_barat: { lat: -8.0645, lng: 111.7065, label: 'Jembatan Ngasinan (Barat), Sungai Ngasinan' },
  cctv18_sungai_temon: { lat: -8.0250, lng: 111.7080, label: 'Sungai Temon, Desa Ngares' },
  cctv19_ngadirenggo: { lat: -8.0950, lng: 111.7330, label: 'Jembatan Ngadirenggo, Kec. Pogalan' },
  cctv20_dermosari_tugu: { lat: -8.0270, lng: 111.6450, label: 'Jalan Ponorogo Tugu, Dermosari' },
  cctv21_panggul_pertigaan_jogja: { lat: -8.2300, lng: 111.4450, label: 'Pertigaan Panggul' },
};

/** Mengekstrak kode stabil dari URL SMIL. */
function codeFromUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  const match = url.match(/smil:([A-Za-z0-9_-]+)(?:\.smil)?/i);
  if (match?.[1]) return match[1].toLowerCase();
  const fallback = url.split('/').filter(Boolean).pop() || 'camera';
  return fallback.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
}

function isOfficialStreamUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' &&
      url.hostname === STREAM_HOST &&
      (url.port === '' || url.port === '443') &&
      url.pathname.startsWith('/live/');
  } catch {
    return false;
  }
}

function normalizeCode(rawCode: string): string {
  return rawCode.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
}

/** Mengurai GeoJSON resmi GEOTIK menjadi daftar kamera. */
export function parseTrenggalekGeoJson(payload: unknown): RawTrenggalekCamera[] {
  if (!Array.isArray(payload)) return [];
  const out: RawTrenggalekCamera[] = [];
  const seen = new Set<string>();

  for (const feature of payload) {
    if (!feature || typeof feature !== 'object') continue;
    const item = feature as {
      properties?: { nama?: unknown; alamat?: unknown };
      geometry?: { coordinates?: unknown; url_streaming?: unknown };
    };
    const rawUrl = typeof item.geometry?.url_streaming === 'string'
      ? item.geometry.url_streaming.trim()
      : '';
    if (!isOfficialStreamUrl(rawUrl)) continue;

    const code = codeFromUrl(rawUrl);
    if (seen.has(code)) continue;
    const coordinates = Array.isArray(item.geometry?.coordinates)
      ? item.geometry.coordinates
      : [];
    const latitude = Number(coordinates[0]);
    const longitude = Number(coordinates[1]);
    const name = typeof item.properties?.nama === 'string' ? item.properties.nama.trim() : '';
    const address = typeof item.properties?.alamat === 'string' ? item.properties.alamat.trim() : '';

    seen.add(code);
    out.push({
      code,
      name: name || code,
      streamUrl: rawUrl,
      location: address && address !== '.' ? address : undefined,
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
    });
  }

  return out;
}

/** Mengurai markup lama TGX menjadi pasangan URL/nama kamera. */
export function parseTrenggalekMarkup(markup: string): RawTrenggalekCamera[] {
  const out: RawTrenggalekCamera[] = [];
  const seen = new Set<string>();
  const re = /playStream\(\s*'([^']+)'\s*,\s*'([^']*)'\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(markup)) !== null) {
    const streamUrl = match[1].replace(/\\\//g, '/').trim();
    if (!isOfficialStreamUrl(streamUrl)) continue;
    const code = normalizeCode(codeFromUrl(streamUrl));
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: match[2] ? match[2].trim() : code, streamUrl });
  }

  return out;
}

// -- Deteksi status online/offline ---------------------------------------------

const probeCache = new Map<string, number>();

async function fetchText(url: string, timeoutMs: number, origin?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      Accept: '*/*',
      'User-Agent': 'lensamas-proxy/1.0',
    };
    if (origin) {
      headers.Origin = origin;
      headers.Referer = `${origin}/`;
    }
    const res = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_TEXT_BYTES) return null;
    const body = await res.text();
    return body.length <= MAX_TEXT_BYTES ? body : null;
  } catch {
    return null;
  }
}

export async function probeTrenggalekStream(
  url: string,
  timeoutMs = 3500
): Promise<'online' | 'offline'> {
  const now = Date.now();
  const lastProbe = probeCache.get(url);
  if (lastProbe && now - lastProbe < 30_000) return 'online';
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  })();
  const master = await fetchText(url, timeoutMs, origin);
  // Master playlist 2xx is the authoritative public availability signal.
  // The child chunklist contains a short-lived generated token; probing it in
  // a separate request creates false offline states when that token expires.
  if (!master || !master.includes('#EXTM3U')) {
    probeCache.delete(url);
    return 'offline';
  }
  probeCache.set(url, now);
  return 'online';
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// -- Cache daftar kamera + snapshot Cloudflare-safe ----------------------------

const LIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

interface ListCacheEntry {
  ts: number;
  items: RawTrenggalekCamera[];
  source: 'geotik' | 'tgx' | 'fallback';
}

const fallbackItems = trenggalekFallback.data as RawTrenggalekCamera[];
let listCache: ListCacheEntry = { ts: 0, items: fallbackItems, source: 'fallback' };
let lastListWasFallback = true;
let inFlight: Promise<RawTrenggalekCamera[]> | null = null;

async function fetchGeotikList(): Promise<RawTrenggalekCamera[]> {
  const body = await fetchText(`${TRENGGALEK_GEOTIK_LIST_URL}?_=${Date.now()}`, 10000, GEOTIK_ORIGIN);
  if (!body) return [];
  try {
    return parseTrenggalekGeoJson(JSON.parse(body));
  } catch {
    return [];
  }
}

async function fetchTgxList(): Promise<RawTrenggalekCamera[]> {
  const body = await fetchText(`${TGX_LIST_URL}?_=${Date.now()}`, 10000, TGX_ORIGIN);
  if (!body) return [];
  let markup = body;
  try {
    const json = JSON.parse(body) as { data?: unknown };
    if (typeof json.data === 'string') markup = json.data;
  } catch {
    // Some deployments return the HTML fragment directly.
  }
  return parseTrenggalekMarkup(markup);
}

async function loadList(forceRefresh: boolean): Promise<RawTrenggalekCamera[]> {
  const now = Date.now();
  if (!forceRefresh && listCache.items.length > 0 && now - listCache.ts < FALLBACK_CACHE_TTL_MS) {
    return listCache.items;
  }

  const geotik = await fetchGeotikList();
  if (geotik.length > 0) {
    listCache = { ts: now, items: geotik, source: 'geotik' };
    lastListWasFallback = false;
    return geotik;
  }

  // Old TGX is kept as a compatibility fallback for deployments that have not
  // exposed the GeoJSON endpoint yet.
  const tgx = await fetchTgxList();
  if (tgx.length > 0) {
    listCache = { ts: now, items: tgx, source: 'tgx' };
    lastListWasFallback = false;
    return tgx;
  }

  if (listCache.items.length > 0) {
    listCache = { ts: now, items: listCache.items, source: 'fallback' };
    lastListWasFallback = true;
    return listCache.items;
  }
  throw new Error('Portal CCTV Trenggalek tidak dapat dijangkau');
}

export async function getRawTrenggalekCameras(forceRefresh = false): Promise<RawTrenggalekCamera[]> {
  if (!forceRefresh && listCache.items.length > 0 && Date.now() - listCache.ts < LIST_CACHE_TTL_MS) {
    return listCache.items;
  }
  if (inFlight) return inFlight;

  inFlight = loadList(forceRefresh)
    .catch((error) => {
      if (fallbackItems.length > 0) {
        listCache = { ts: Date.now(), items: fallbackItems, source: 'fallback' };
        lastListWasFallback = true;
        return fallbackItems;
      }
      throw error;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function toTrenggalekCameras(
  raw: RawTrenggalekCamera[],
  statuses: Array<'online' | 'offline' | undefined>
): TrenggalekCamera[] {
  return raw.map((item, index) => {
    STREAM_TARGETS.set(item.code, item.streamUrl);
    const coord = COORDINATES[item.code];
    const latitude = Number.isFinite(item.latitude) ? item.latitude as number : coord?.lat;
    const longitude = Number.isFinite(item.longitude) ? item.longitude as number : coord?.lng;
    return {
      slug: `trenggalek-${item.code}`,
      name: item.name || `CCTV ${item.code}`,
      location: item.location || coord?.label || 'Kabupaten Trenggalek',
      latitude: latitude ?? -8.0497,
      longitude: longitude ?? 111.7087,
      status: statuses[index] || 'online',
      source: 'trenggalek',
      protocol: 'hls',
      streamUrl: proxyAssetUrl(item.code, defaultStreamAsset(item.streamUrl)),
      sourceCode: item.code,
    };
  });
}

const PROBE_CONCURRENCY = 12;
const PROBE_TIMEOUT_MS = 3500;
const PROBE_HARD_CAP_MS = 8000;

function rewriteTrenggalekPlaylist(text: string, sourceUrl: URL, code: string): string {
  const rootPath = streamRoot(sourceUrl.pathname);
  return rewriteRegionalPlaylist(text, sourceUrl, (absolute) => {
    if (absolute.origin !== sourceUrl.origin || !absolute.pathname.startsWith(rootPath)) return null;
    const asset = absolute.pathname.slice(rootPath.length);
    return safeStreamAsset(asset) ? proxyAssetUrl(code, asset) : null;
  });
}

export async function handleTrenggalekHls(
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl = new URL(req.url || '', 'http://localhost')
): Promise<void> {
  setRegionalGetCors(res);
  const code = requestUrl.searchParams.get('camera') || '';
  const asset = requestUrl.searchParams.get('asset') || '';
  if (!STREAM_CODE_RE.test(code) || (asset && !safeStreamAsset(asset))) {
    sendRegionalJson(res, 400, { error: 'Parameter stream Trenggalek tidak valid.' });
    return;
  }

  let rawTarget: string | undefined;
  try {
    rawTarget = await resolveStreamTarget(code);
  } catch {
    sendRegionalJson(res, 502, { error: 'Target stream Trenggalek tidak dapat dimuat.' });
    return;
  }
  if (!rawTarget) {
    sendRegionalJson(res, 404, { error: 'Kamera Trenggalek tidak ditemukan.' });
    return;
  }

  let base: URL;
  try {
    base = new URL(rawTarget);
  } catch {
    sendRegionalJson(res, 502, { error: 'Target stream Trenggalek tidak valid.' });
    return;
  }
  if (base.protocol !== 'https:' || base.hostname !== STREAM_HOST || !base.pathname.startsWith('/live/')) {
    sendRegionalJson(res, 403, { error: 'Host stream Trenggalek tidak diizinkan.' });
    return;
  }
  const rootPath = streamRoot(base.pathname);
  const requestedAsset = asset || base.pathname.slice(rootPath.length) || 'playlist.m3u8';
  if (!safeStreamAsset(requestedAsset)) {
    sendRegionalJson(res, 400, { error: 'Asset stream Trenggalek tidak valid.' });
    return;
  }
  const target = new URL(requestedAsset, base);
  target.search = base.search;
  if (target.origin !== base.origin || !target.pathname.startsWith(rootPath)) {
    sendRegionalJson(res, 400, { error: 'Target stream Trenggalek tidak diizinkan.' });
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
    sendRegionalJson(res, 502, { error: 'Proxy stream Trenggalek gagal.' });
    return;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    noteUpstreamStatus('trenggalek', code, response.status);
    sendUpstreamStreamError(res, response.status, `Stream Trenggalek membalas HTTP ${response.status}.`, {
      upstreamStatus: response.status,
    });
    return;
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (requestedAsset.toLowerCase().endsWith('.m3u8') || contentType.includes('mpegurl')) {
    try {
      const text = await readRegionalText(response, REGIONAL_MAX_PLAYLIST_BYTES, 'manifest Trenggalek');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.end(rewriteTrenggalekPlaylist(text, target, code));
    } catch {
      if (!res.headersSent) sendRegionalJson(res, 502, { error: 'Manifest Trenggalek tidak dapat diproses.' });
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

  const reqUrl = new URL(req.url || '', 'http://localhost');
  const mode = reqUrl.searchParams.get('mode') || 'list';
  if (mode === 'hls') {
    await handleTrenggalekHls(req, res, reqUrl);
    return;
  }
  if (mode !== 'list') {
    sendRegionalJson(res, 400, { error: 'Mode Trenggalek tidak valid.' });
    return;
  }

  const forceRefresh = reqUrl.searchParams.get('refresh') === '1';
  // Map load tidak boleh menunggu probe dozens of stream; probe=1 remains available for diagnostics.
  const skipProbe = reqUrl.searchParams.get('probe') !== '1';

  try {
    const raw = await getRawTrenggalekCameras(forceRefresh);
    let statuses: Array<'online' | 'offline' | undefined> = [];
    if (!skipProbe) {
      const probed = await Promise.race([
        mapWithConcurrency(raw, PROBE_CONCURRENCY, (camera) =>
          probeTrenggalekStream(camera.streamUrl, PROBE_TIMEOUT_MS)
        ),
        new Promise<Array<'online' | 'offline' | undefined>>((resolve) =>
          setTimeout(() => resolve([]), PROBE_HARD_CAP_MS)
        ),
      ]);
      statuses = Array.isArray(probed) && probed.length === raw.length ? probed : [];
    }

    const data = toTrenggalekCameras(raw, statuses);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('X-Lensamas-Data', lastListWasFallback ? 'stale' : 'fresh');
    res.statusCode = 200;
    res.end(JSON.stringify({
      data: markOfflineCameras('trenggalek', data),
      source: 'trenggalek',
      upstream: listCache.source,
    }));
  } catch {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({
      error: 'Sumber CCTV Trenggalek tidak dapat dijangkau.',
    }));
  }
}
