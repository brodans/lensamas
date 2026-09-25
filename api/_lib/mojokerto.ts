import type { IncomingMessage, ServerResponse } from 'node:http';

import mojokertoFallback from './mojokerto-fallback.json' with { type: 'json' };
import {
  MOJOKERTO_LIST_URL,
  MOJOKERTO_ORIGIN,
  MOJOKERTO_STREAM_BASE,
} from './config.js';

import {
  sendDegradedList,
} from './regional-hls.js';
import {
  markOfflineCameras,
} from './stream-circuit.js';

interface MojokertoRawCamera {
  id?: unknown;
  nama?: unknown;
  lat?: unknown;
  lng?: unknown;
  persimpangan?: unknown;
  persimpanganArah?: unknown;
  jenisCctv?: unknown;
  tipe?: unknown;
}

export interface MojokertoCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: 'online';
  source: 'mojokerto';
  protocol: 'flv';
  streamUrl: string;
  sourceCode: string;
  category?: string;
  cameraType?: string;
}

interface CacheEntry {
  expiresAt: number;
  cameras: MojokertoCamera[];
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Snapshot publik menjaga integrasi tetap hidup di Vercel ketika Cloudflare
// sempat menolak request dari egress datacenter. Media WSS tetap dibuka browser.
let listCache: CacheEntry | null = {
  expiresAt: 0,
  cameras: mojokertoFallback.data as MojokertoCamera[],
};
let inFlight: Promise<MojokertoCamera[]> | null = null;
let lastListWasFallback = true;

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function coordinate(value: unknown): number | null {
  const raw = typeof value === 'number' ? String(value) : text(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueParts(...values: string[]): string {
  return [...new Set(values.filter(Boolean))].join(' — ');
}

/** Buang field jaringan privat dan normalisasi hanya data yang diperlukan peta. */
export function normalizeMojokertoCameras(raw: MojokertoRawCamera[]): MojokertoCamera[] {
  const cameras: MojokertoCamera[] = [];
  const seen = new Set<string>();
  const streamBase = MOJOKERTO_STREAM_BASE.replace(/\/+$/, '');

  for (const item of raw) {
    const id = text(item.id).toLowerCase();
    if (!UUID_RE.test(id) || seen.has(id)) continue;

    const latitude = coordinate(item.lat);
    const longitude = coordinate(item.lng);
    if (latitude === null || longitude === null) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;

    const name = text(item.nama) || `CCTV ${text(item.persimpangan) || 'Mojokerto'}`;
    const location = uniqueParts(text(item.persimpangan), text(item.persimpanganArah)) || 'Kabupaten Mojokerto';
    const category = text(item.jenisCctv) || undefined;
    const cameraType = text(item.tipe) || undefined;

    seen.add(id);
    cameras.push({
      slug: `mojokerto-${id}`,
      name,
      location,
      latitude,
      longitude,
      // API publik tidak menyediakan status koneksi. Player melakukan retry
      // dan hanya menandai LIVE setelah frame FLV pertama benar-benar tampil.
      status: 'online',
      source: 'mojokerto',
      protocol: 'flv',
      streamUrl: `${streamBase}/${encodeURIComponent(id)}`,
      sourceCode: id,
      category,
      cameraType,
    });
  }

  return cameras;
}

async function fetchMojokertoCameras(): Promise<MojokertoCamera[]> {
  const response = await fetch(MOJOKERTO_LIST_URL, {
    redirect: 'manual',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Origin: MOJOKERTO_ORIGIN,
      Referer: `${MOJOKERTO_ORIGIN}/`,
      'User-Agent': 'lensamas-proxy/1.0',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Portal Mojokerto membalas HTTP ${response.status}.`);

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 2 * 1024 * 1024) throw new Error('Respons portal Mojokerto terlalu besar.');
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error('Respons portal Mojokerto terlalu besar.');
  const payload = JSON.parse(body) as { data?: unknown };
  if (!Array.isArray(payload.data)) throw new Error('Respons portal Mojokerto tidak berisi data CCTV.');
  const cameras = normalizeMojokertoCameras(payload.data as MojokertoRawCamera[]);
  if (cameras.length === 0) throw new Error('Portal Mojokerto tidak memuat kamera yang valid.');
  return cameras;
}

async function getCameras(): Promise<MojokertoCamera[]> {
  if (listCache && listCache.expiresAt > Date.now()) return listCache.cameras;
  if (inFlight) return inFlight;

  inFlight = fetchMojokertoCameras()
    .then((cameras) => {
      listCache = { cameras, expiresAt: Date.now() + CACHE_TTL_MS };
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
      inFlight = null;
    });
  return inFlight;
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
    res.setHeader('Allow', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  try {
    const cameras = await getCameras();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600');
    res.setHeader('X-Lensamas-Data', lastListWasFallback ? 'stale' : 'fresh');
    res.end(JSON.stringify({ data: markOfflineCameras('mojokerto', cameras), source: 'mojokerto' }));
  } catch (error) {
    sendDegradedList(res, 'mojokerto', mojokertoFallback.data, (error as Error).message);
  }
}
