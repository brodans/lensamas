import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  BONDOWOSO_BASE_URL,
  BONDOWOSO_PAGE_PATH,
  BONDOWOSO_STREAM_BASE,
  BONDOWOSO_STREAM_MAX_FPS,
  BONDOWOSO_STREAM_PASS,
  BONDOWOSO_STREAM_SCALE,
  BONDOWOSO_STREAM_USER,
  REGIONAL_CCTV_USER_AGENT,
} from './config.js';
import {
  readRegionalText,
  regionalHeaders,
  regionalTarget,
  sendRegionalJson,
  setRegionalGetCors,
  REGIONAL_REQUEST_TIMEOUT_MS,
} from './regional-hls.js';
import { serveMjpegProxy } from './mjpeg-proxy.js';
import { redactLogMessage, shouldWriteProviderLog } from './request-log.js';

import {
  sendDegradedList,
} from './regional-hls.js';
import { seedListCache } from './list-snapshot.js';
import {
  markOfflineCameras,
} from './stream-circuit.js';

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const MONITOR_RE = /^\d{1,4}$/;
const baseUrl = new URL(BONDOWOSO_BASE_URL.endsWith('/') ? BONDOWOSO_BASE_URL : `${BONDOWOSO_BASE_URL}/`);
const streamUrl = new URL(BONDOWOSO_STREAM_BASE);

interface BondowosoCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: 'unknown';
  device_status: 'not_reported';
  source: 'bondowoso';
  protocol: 'mjpeg';
  codec: 'mjpeg';
  channel: number;
  streamUrl: string;
  sourceCode: string;
  streamConfigured: boolean;
}

interface CacheEntry {
  ts: number;
  cameras: BondowosoCamera[];
}

let listCache: CacheEntry | null = seedListCache<BondowosoCamera>('bondowoso');
let lastListWasStale = false;
let listInFlight: Promise<BondowosoCamera[]> | null = null;

function logBondowoso(level: 'info' | 'error', payload: Record<string, unknown>): void {
  if (!shouldWriteProviderLog(level)) return;
  if (level === 'info' && payload.event === 'stream-response') return;
  const line = `[lensamas-bondowoso] ${JSON.stringify({ source: 'bondowoso', ...payload })}`;
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

function proxyStreamUrl(monitor: string): string {
  return `/api/hls-proxy?${new URLSearchParams({
    source: 'bondowoso',
    mode: 'mjpeg',
    camera: monitor,
  }).toString()}`;
}

function parsePage(html: string): BondowosoCamera[] {
  const cameras: BondowosoCamera[] = [];
  const seen = new Set<string>();
  const blocks = html.split(/^\s*const\s+marker_/m).slice(1);
  for (const block of blocks) {
    const coordinates = block.match(/L\.marker\(\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/i);
    const hrefMatch = block.match(/href\s*=\s*(["'])(.*?)\1/i);
    const nameMatch = block.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
    if (!coordinates || !hrefMatch || !nameMatch) continue;

    let monitor = '';
    try {
      const parsedHref = new URL(decodeHtml(hrefMatch[2]));
      if (parsedHref.origin !== 'https://cctv.bondowosokab.go.id' || parsedHref.pathname !== '/cgi-bin/nph-zms') continue;
      monitor = parsedHref.searchParams.get('monitor') || '';
    } catch {
      continue;
    }
    if (!MONITOR_RE.test(monitor) || seen.has(monitor)) continue;

    let latitude = Number(coordinates[1]);
    const longitude = Number(coordinates[2]);
    // Koreksi salah ketik koordinat yang pernah publishes pada monitor 11.
    if (monitor === '11' && latitude < -9) latitude = -7.909748884214162;
    const name = decodeHtml(nameMatch[1].replace(/<[^>]+>/g, ' ')).slice(0, 200);
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    seen.add(monitor);
    cameras.push({
      slug: `bondowoso-monitor-${monitor}`,
      name,
      location: 'Kabupaten Bondowoso',
      latitude,
      longitude,
      status: 'unknown',
      device_status: 'not_reported',
      source: 'bondowoso',
      protocol: 'mjpeg',
      codec: 'mjpeg',
      channel: Number(monitor),
      streamUrl: proxyStreamUrl(monitor),
      sourceCode: monitor,
      streamConfigured: Boolean(BONDOWOSO_STREAM_USER.trim() && BONDOWOSO_STREAM_PASS.trim()),
    });
  }
  if (cameras.length === 0) throw new Error('Halaman Bondowoso tidak memuat marker CCTV yang valid.');
  return cameras;
}

async function fetchPage(requestId: string): Promise<BondowosoCamera[]> {
  const target = regionalTarget(baseUrl, BONDOWOSO_PAGE_PATH, 'Bondowoso');
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(target, {
      headers: regionalHeaders(REGIONAL_CCTV_USER_AGENT, { Accept: 'text/html,application/xhtml+xml' }),
      signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logBondowoso('error', {
      event: 'metadata-error',
      requestId,
      durationMs: Date.now() - startedAt,
      error: redactLogMessage((error as Error).message),
    });
    throw error;
  }
  logBondowoso('info', {
    event: 'metadata-response',
    requestId,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  if (!response.ok) throw new Error(`Halaman Bondowoso membalas HTTP ${response.status}.`);
  const text = await readRegionalText(response, MAX_PAGE_BYTES, 'halaman Bondowoso');
  return parsePage(text);
}

async function getBondowosoCameras(
  forceRefresh = false,
  requestId = 'unknown'
): Promise<BondowosoCamera[]> {
  const now = Date.now();
  if (!forceRefresh && listCache && now - listCache.ts < LIST_CACHE_TTL_MS) return listCache.cameras;
  if (listInFlight) return listInFlight;
  listInFlight = fetchPage(requestId)
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

function configuredStreamTarget(monitor: string): URL | null {
  const user = BONDOWOSO_STREAM_USER.trim();
  const pass = BONDOWOSO_STREAM_PASS.trim();
  if (!user || !pass) return null;
  const target = new URL(streamUrl);
  if (target.protocol !== 'https:' || target.hostname !== 'cctv.bondowosokab.go.id' || target.pathname !== '/cgi-bin/nph-zms') {
    throw new Error('Konfigurasi stream Bondowoso tidak valid.');
  }
  const scale = Math.min(100, Math.max(1, Number(BONDOWOSO_STREAM_SCALE) || 50));
  const maxFps = Math.min(15, Math.max(1, Number(BONDOWOSO_STREAM_MAX_FPS) || 10));
  target.searchParams.set('scale', String(scale));
  // nph-zms harus memakai mode mjpeg agar <img> menerima multipart live.
  target.searchParams.set('mode', 'mjpeg');
  target.searchParams.set('maxfps', String(maxFps));
  target.searchParams.set('monitor', monitor);
  target.searchParams.set('user', user);
  target.searchParams.set('pass', pass);
  return target;
}

async function handleMjpeg(
  _req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  requestId: string
): Promise<void> {
  const monitor = requestUrl.searchParams.get('camera') || '';
  if (!MONITOR_RE.test(monitor)) {
    sendRegionalJson(res, 400, { error: 'Monitor stream Bondowoso tidak valid.' });
    return;
  }
  const cameras = await getBondowosoCameras(false, requestId);
  if (!cameras.some((camera) => camera.sourceCode === monitor)) {
    sendRegionalJson(res, 404, { error: 'Monitor Bondowoso tidak ditemukan.' });
    return;
  }
  const target = configuredStreamTarget(monitor);
  if (!target) {
    sendRegionalJson(res, 503, {
      error: 'Stream Bondowoso belum dikonfigurasi. Isi BONDOWOSO_STREAM_USER dan BONDOWOSO_STREAM_PASS di environment server.',
    });
    return;
  }

  await serveMjpegProxy(_req, res, {
    source: 'bondowoso',
    monitor,
    requestId,
    target,
    expectedOrigin: 'https://cctv.bondowosokab.go.id',
    pathPrefix: '/cgi-bin/nph-zms',
    log: logBondowoso,
  });
}

export async function handleBondowoso(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setRegionalGetCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendRegionalJson(res, 405, { error: 'Method Bondowoso tidak valid.' });
    return;
  }
  const requestUrl = new URL(req.url || '', 'http://localhost');
  const mode = requestUrl.searchParams.get('mode') || 'list';
  const requestId = String(res.getHeader('X-Request-Id') || 'unknown');
  if (mode === 'list') {
    try {
      const cameras = await getBondowosoCameras(requestUrl.searchParams.get('refresh') === '1', requestId);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=900');
      res.setHeader('X-Lensamas-Data', lastListWasStale ? 'stale' : 'fresh');
      res.setHeader('X-Lensamas-Stale', lastListWasStale ? '1' : '0');
      res.end(JSON.stringify({ data: markOfflineCameras('bondowoso', cameras), source: 'bondowoso' }));
    } catch (error) {
      sendDegradedList(res, 'bondowoso', listCache?.cameras || [], (error as Error).message);
    }
    return;
  }
  if (mode === 'mjpeg') {
    try {
      await handleMjpeg(req, res, requestUrl, requestId);
    } catch (error) {
      if (!res.headersSent) sendRegionalJson(res, 502, { error: `Proxy stream Bondowoso gagal: ${(error as Error).message}` });
    }
    return;
  }
  sendRegionalJson(res, 400, { error: 'Mode Bondowoso tidak valid.' });
}
