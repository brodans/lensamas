import type { IncomingMessage, ServerResponse } from 'node:http';

import { API_BASE_URL as BASE, API_ORIGIN as ORIGIN, API_TOKEN as TOKEN } from './_lib/config.js';

function setCors(res: ServerResponse): void {
  res.setHeader('Vary', 'Origin');
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

  try {
    const headers: Record<string, string> = {
      Origin: ORIGIN,
      'User-Agent': 'lensamas-proxy/1.0',
      Accept: 'application/json',
    };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

    const upstreamRes = await fetch(`${BASE}/api/v1/wifi/points`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    const body = await upstreamRes.text();
    const ct = upstreamRes.headers.get('content-type');
    if (ct) {
      res.setHeader('Content-Type', ct.split(';')[0]);
    }
    res.setHeader(
      'Cache-Control',
      upstreamRes.ok
        ? 'public, max-age=30, s-maxage=60, stale-while-revalidate=300'
        : 'no-store'
    );
    res.statusCode = upstreamRes.status;
    res.end(body);
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Upstream error: ${(e as Error).message}` }));
  }
}
