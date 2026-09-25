import type { IncomingMessage, ServerResponse } from 'node:http';

import { API_BASE_URL as BASE, API_ORIGIN as ORIGIN, API_TOKEN as TOKEN } from '../_lib/config.js';

import {
  isContentUnavailable,
  sendCircuitResponse,
  sendContentUnavailable,
  sendStreamGatewayError,
} from '../_lib/regional-hls.js';
import {
  noteStreamHealthy,
  noteStreamUnavailable,
  noteStreamUnreachable,
  streamCooldown,
} from '../_lib/stream-circuit.js';

function setCors(res: ServerResponse): void {
  res.setHeader('Vary', 'Origin');
}

export default async function handler(
  req: IncomingMessage & { query?: Record<string, string | string[]> },
  res: ServerResponse
): Promise<void> {
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

  const rawUrl = req.url || '';
  const parsed = new URL(rawUrl, 'http://localhost');
  const querySlug = req.query?.slug;
  const rawSlug = typeof querySlug === 'string' ? querySlug : parsed.pathname.replace(/^\/api\/stream\/?/, '');
  let slug: string;
  try {
    slug = decodeURIComponent(rawSlug.split('?')[0]);
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Parameter slug tidak valid' }));
    return;
  }

  if (!slug) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Parameter slug wajib diisi' }));
    return;
  }

  const cooldown = streamCooldown('ponorogo', slug);
  if (cooldown) {
    sendCircuitResponse(res, cooldown, 'Stream CCTV sedang tidak tersedia.');
    return;
  }

  try {
    const headers: Record<string, string> = {
      Origin: ORIGIN,
      'User-Agent': 'lensamas-proxy/1.0',
      Accept: 'application/json',
    };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

    const upstreamRes = await fetch(`${BASE}/api/v1/cctv/cameras/${encodeURIComponent(slug)}/stream`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!upstreamRes.ok) {
      // 404 upstream berarti kamera tidak tersedia, bukan proxy yang rusak.
      if (isContentUnavailable(upstreamRes.status)) {
        noteStreamUnavailable('ponorogo', slug);
        sendContentUnavailable(res, 'Stream CCTV tidak tersedia.');
        return;
      }
      noteStreamUnreachable('ponorogo', slug);
      sendStreamGatewayError(res, `Server stream membalas HTTP ${upstreamRes.status}.`, {
        upstreamStatus: upstreamRes.status,
      });
      return;
    }
    noteStreamHealthy('ponorogo', slug);
    const body = await upstreamRes.text();
    const ct = upstreamRes.headers.get('content-type');
    if (ct) {
      res.setHeader('Content-Type', ct.split(';')[0]);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    res.end(body);
  } catch (e) {
    noteStreamUnreachable('ponorogo', slug);
    sendStreamGatewayError(res, (e as Error).message);
  }
}
