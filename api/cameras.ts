import type { IncomingMessage, ServerResponse } from 'node:http';

import { API_BASE_URL as BASE, API_ORIGIN as ORIGIN, API_TOKEN as TOKEN } from './_lib/config.js';

import {
  sendDegradedList,
} from './_lib/regional-hls.js';
import { snapshotCameras } from './_lib/list-snapshot.js';

function setCors(res: ServerResponse): void {
  // Endpoint ini memakai token server-side; aplikasi Lensamas memakai
  // same-origin sehingga tidak diperlukan wildcard CORS.
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

    const upstreamRes = await fetch(`${BASE}/api/v1/cctv/cameras`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!upstreamRes.ok) {
      // Nawasara sedang bermasalah: kirim snapshot lokal dengan status 200
      // supaya aplikasi tetap punya kamera Ponorogo dan tidak ada 5xx.
      sendDegradedList(res, 'ponorogo', snapshotCameras('ponorogo'), `Nawasara HTTP ${upstreamRes.status}`);
      return;
    }
    const body = await upstreamRes.text();
    const ct = upstreamRes.headers.get('content-type');
    if (ct) {
      res.setHeader('Content-Type', ct.split(';')[0]);
    }
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
    res.statusCode = 200;
    res.end(body);
  } catch (e) {
    sendDegradedList(res, 'ponorogo', snapshotCameras('ponorogo'), (e as Error).message);
  }
}
