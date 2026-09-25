import type { IncomingMessage, ServerResponse } from 'node:http';

import { TULUNGAGUNG_LIST_URL } from './config.js';
import { isUpstreamCoolingDown, sendDegradedList } from './regional-hls.js';
import { seedListCache } from './list-snapshot.js';
import { markOfflineCameras } from './stream-circuit.js';

const LIST_URL = TULUNGAGUNG_LIST_URL;
const LIST_CACHE_TTL_MS = 5 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

interface CacheEntry {
  ts: number;
  cameras: JsonRecord[];
}

/** Cache awal dari snapshot: list tidak pernah 5xx walau upstream mati. */
let listCache: CacheEntry | null = seedListCache<JsonRecord>('tulungagung');
let listInFlight: Promise<JsonRecord[]> | null = null;
let lastListWasStale = false;

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function resolveValue(values: unknown[], value: unknown, stack = new Set<number>()): unknown {
  if (typeof value !== 'number' || value < 0 || value >= values.length) return value;
  if (stack.has(value)) return null;
  stack.add(value);
  const item = values[value];
  if (Array.isArray(item)) return item.map((entry) => resolveValue(values, entry, new Set(stack)));
  if (item && typeof item === 'object') {
    return Object.fromEntries(
      Object.entries(item).map(([key, entry]) => [key, resolveValue(values, entry, new Set(stack))])
    );
  }
  return item;
}

function normalizeCameras(payload: JsonRecord): JsonRecord[] {
  const values = (payload.nodes as JsonRecord[] | undefined)?.[2]?.data;
  if (!Array.isArray(values)) return [];
  const root = values[0] as JsonRecord | undefined;
  const streams = resolveValue(values, root?.streams);
  if (!Array.isArray(streams)) return [];

  return streams.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const camera = item as JsonRecord;
    const coordinates = camera.latLng as JsonRecord | undefined;
    const stats = camera.stats as JsonRecord | undefined;
    const hexid = typeof camera.hexid === 'string' ? camera.hexid : '';
    const latitude = typeof coordinates?.lat === 'number' ? coordinates.lat : 0;
    const longitude = typeof coordinates?.lng === 'number' ? coordinates.lng : 0;
    if (!hexid || !latitude || !longitude) return [];

    return [{
      slug: `tulungagung-${hexid}`,
      name: typeof camera.name === 'string' ? camera.name : `CCTV Tulungagung ${index + 1}`,
      location: typeof camera.address === 'string' ? camera.address : 'Tulungagung',
      latitude,
      longitude,
      status: stats?.isOnline ? 'online' : 'offline',
      source: 'tulungagung',
      protocol: 'hls',
      streamUrl: `/api/hls-proxy?source=tulungagung&src=${encodeURIComponent(hexid)}&asset=stream.m3u8`,
      sourceCode: hexid,
    }];
  });
}

async function fetchUpstreamCameras(): Promise<JsonRecord[]> {
  const response = await fetch(LIST_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'lensamas-proxy/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Tulungagung returned HTTP ${response.status}`);
  return normalizeCameras((await response.json()) as JsonRecord);
}

async function getTulungagungCameras(forceRefresh: boolean): Promise<JsonRecord[]> {
  const now = Date.now();
  if (!forceRefresh && listCache && now - listCache.ts < LIST_CACHE_TTL_MS) return listCache.cameras;
  if (listInFlight) return listInFlight;

  listInFlight = fetchUpstreamCameras()
    .then((cameras) => {
      listCache = { ts: Date.now(), cameras };
      lastListWasStale = false;
      return cameras;
    })
    .catch((error: unknown) => {
      if (!listCache) throw error;
      lastListWasStale = true;
      // Jeda percobaan ulang supaya upstream yang mati tidak dipanggil tiap request.
      listCache = { ts: Date.now(), cameras: listCache.cameras };
      return listCache.cameras;
    })
    .finally(() => {
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
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  const requestUrl = new URL(req.url || '', 'http://localhost');
  const forceRefresh = requestUrl.searchParams.get('refresh') === '1';
  if (!forceRefresh && isUpstreamCoolingDown('tulungagung')) {
    sendDegradedList(res, 'tulungagung', listCache?.cameras || [], 'upstream belum pulih');
    return;
  }

  try {
    const cameras = await getTulungagungCameras(forceRefresh);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=900');
    res.setHeader('X-Lensamas-Data', lastListWasStale ? 'stale' : 'fresh');
    res.setHeader('X-Lensamas-Stale', lastListWasStale ? '1' : '0');
    res.statusCode = 200;
    res.end(JSON.stringify({ data: markOfflineCameras('tulungagung', cameras), source: 'tulungagung' }));
  } catch (error) {
    sendDegradedList(res, 'tulungagung', listCache?.cameras || [], (error as Error).message);
  }
}
