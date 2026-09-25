import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getRawSaranganCameras,
  mapWithConcurrency,
  probeStreamStatus,
  toSaranganCameras,
} from './sarangan.js';

import {
  sendDegradedList,
} from './regional-hls.js';
import { snapshotCameras } from './list-snapshot.js';
import {
  markOfflineCameras,
} from './stream-circuit.js';

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/** Konkurensi & timeout probe agar pemuatan pertama tetap cepat. */
const PROBE_CONCURRENCY = 10;
const PROBE_TIMEOUT_MS = 3000;

/**
 * Daftar CCTV Kabupaten Magetan (sumber publik Sarangan Vision) beserta
 * status online/offline yang dideteksi dari manifest HLS masing-masing kamera.
 *
 * Query:
 *  - `?refresh=1` memaksa pengambilan ulang daftar dari halaman sumber
 *    (cache daftar in-memory memiliki TTL 6 jam).
 *  - `?probe=1` menjalankan probe liveness; default map load hanya metadata.
 */
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

  const url = new URL(req.url || '', 'http://localhost');
  const forceRefresh = url.searchParams.get('refresh') === '1';
  const shouldProbe = url.searchParams.get('probe') === '1';

  try {
    const raw = await getRawSaranganCameras(forceRefresh);
    const statuses = shouldProbe
      ? await mapWithConcurrency(raw, PROBE_CONCURRENCY, (camera) =>
          probeStreamStatus(camera.streamUrl, PROBE_TIMEOUT_MS)
        )
      : raw.map(() => 'unknown' as const);
    const data = toSaranganCameras(raw, statuses);

    res.setHeader('Content-Type', 'application/json');
    // Default map load tidak melakukan probe; cache list cukup untuk meredam cost.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=900');
    res.statusCode = 200;
    res.end(JSON.stringify({ data: markOfflineCameras('magetan', data), source: 'magetan' }));
  } catch (err) {
    // Upstream pemerintah tidak stabil: kirim data terakhir yang diketahui baik
    // dengan status 200 supaya tidak ada 5xx dari sisi Lensamas.
    sendDegradedList(res, 'magetan', snapshotCameras('magetan'), (err as Error).message);
  }
}
