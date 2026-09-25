import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleMalangStream, handleTulungagungStream } from './hls-proxy.js';
import { handleSurabaya } from './surabaya.js';
import { handleBojonegoro } from './bojonegoro.js';
import { handleGresik } from './gresik.js';
import { handleTuban } from './tuban.js';
import { handleBanyuwangi } from './banyuwangi.js';
import { handleBondowoso } from './bondowoso.js';
import { handleSitubondo } from './situbondo.js';
import { handlePasuruan } from './pasuruan.js';
import { handleTrenggalekHls } from './trenggalek.js';
import { handleKediriHls } from './kediri.js';
import { isUpstreamCoolingDown, sendDegradedList } from './regional-hls.js';
import { snapshotCameras } from './list-snapshot.js';
import { redactLogMessage } from './request-log.js';

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

type RegionalHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const sourceHandlers: Record<string, RegionalHandler> = {
  surabaya: handleSurabaya,
  bojonegoro: handleBojonegoro,
  gresik: handleGresik,
  tuban: handleTuban,
  banyuwangi: handleBanyuwangi,
  bondowoso: handleBondowoso,
  situbondo: handleSitubondo,
  pasuruan: handlePasuruan,
  trenggalek: handleTrenggalekHls,
  kediri: handleKediriHls,
};
const streamOnlySources = ['malang', 'tulungagung'] as const;
const acceptedSources = [...Object.keys(sourceHandlers), ...streamOnlySources];

/** Satu route Vercel untuk proxy HLS dan metadata publik sumber CCTV. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  const requestUrl = new URL(req.url || '', 'http://localhost');
  const source = requestUrl.searchParams.get('source');
  if (source) res.setHeader('X-Lensamas-Source', source);
  const mode = requestUrl.searchParams.get('mode') || 'list';

  // Sumber yang baru saja gagal tidak perlu dicoba lagi selama cooldown.
  // Permintaan list dijawab dari snapshot dengan status 200 supaya Vercel
  // tidak mencatat 5xx untuk masalah upstream milik pihak ketiga.
  if (req.method === 'GET' && source && mode === 'list' && isUpstreamCoolingDown(source)) {
    sendDegradedList(res, source, snapshotCameras(source), 'upstream belum pulih');
    return;
  }

  const regionalHandler = source ? sourceHandlers[source] : undefined;
  if (regionalHandler) {
    try {
      await regionalHandler(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: `Proxy ${source} gagal: ${redactLogMessage((error as Error).message)}` }));
      }
    }
    return;
  }
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
    if (source === 'malang') {
      await handleMalangStream(req, res);
      return;
    }
    if (source === 'tulungagung') {
      await handleTulungagungStream(req, res);
      return;
    }
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: `Parameter source harus ${acceptedSources.join(', ')}.` }));
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `Proxy HLS gagal: ${redactLogMessage((error as Error).message)}` }));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}
