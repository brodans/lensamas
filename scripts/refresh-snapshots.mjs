#!/usr/bin/env node
/**
 * Membuat `api/_lib/snapshots.json` dari data live.
 *
 * Snapshot dipakai sebagai cache awal setiap sumber CCTV. Tujuannya:
 * 1. Function Vercel tidak pernah balas 5xx hanya karena upstream pemerintah
 *    sedang lambat/down; list selalu punya data terakhir yang diketahui baik.
 * 2. Peta tetap menampilkan seluruh kamera walau semua upstream mati.
 *
 * Pemakaian:
 *   node scripts/refresh-snapshots.mjs
 *   LENSAMAS_BASE=https://domain.vercel.app node scripts/refresh-snapshots.mjs
 *
 * Tidak ada credential yang disimpan: snapshot hanya berisi field publik
 * (slug, nama, lokasi, koordinat, status, dan URL proxy same-origin).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(HERE, '..', 'api', '_lib', 'snapshots.json');
const BASE = (process.env.LENSAMAS_BASE || 'http://127.0.0.1:5199').replace(/\/+$/, '');

/** Endpoint list per sumber. Sesuaikan dengan routing di `api/_lib/hls-router.ts`. */
const ROUTES = {
  ponorogo: '/api/cameras',
  madiun: '/api/madiun',
  magetan: '/api/sarangan',
  trenggalek: '/api/trenggalek',
  kediri: '/api/kediri',
  tulungagung: '/api/tulungagung',
  malang: '/api/malang',
  mojokerto: '/api/mojokerto',
  surabaya: '/api/hls-proxy?source=surabaya&mode=list',
  bojonegoro: '/api/hls-proxy?source=bojonegoro&mode=list',
  gresik: '/api/hls-proxy?source=gresik&mode=list',
  tuban: '/api/hls-proxy?source=tuban&mode=list',
  banyuwangi: '/api/hls-proxy?source=banyuwangi&mode=list',
  bondowoso: '/api/hls-proxy?source=bondowoso&mode=list',
  situbondo: '/api/hls-proxy?source=situbondo&mode=list',
  pasuruan: '/api/hls-proxy?source=pasuruan&mode=list',
};

/** Field yang berubah tiap detach dan tidak perlu dibekukan. */
const VOLATILE_FIELDS = new Set(['last_seen_at', 'expiresAt', 'thumbUrl']);

function cleanCamera(camera) {
  const output = {};
  for (const [key, value] of Object.entries(camera)) {
    if (VOLATILE_FIELDS.has(key) || value === null || value === undefined) continue;
    output[key] = value;
  }
  return output;
}

async function fetchSource(source, route) {
  try {
    const response = await fetch(`${BASE}${route}`, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.data)) throw new Error('respons tidak memuat array data');
    return {
      cameras: payload.data.map(cleanCamera),
      degraded: response.headers.get('x-lensamas-degraded') === '1',
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function loadPrevious() {
  try {
    const parsed = JSON.parse(readFileSync(OUTPUT, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.sources ? parsed.sources : {};
  } catch {
    return {};
  }
}

const previous = loadPrevious();
const sources = { ...previous };
let total = 0;
let failed = 0;

for (const [source, route] of Object.entries(ROUTES)) {
  process.stdout.write(`- ${source.padEnd(12)} `);
  const result = await fetchSource(source, route);
  if (result.error || result.cameras.length === 0) {
    failed += 1;
    const kept = Array.isArray(previous[source]) ? previous[source].length : 0;
    process.stdout.write(`GAGAL (${result.error || 'kosong'}) — snapshot lama ${kept} kamera dipertahankan\n`);
    continue;
  }
  sources[source] = result.cameras;
  total += result.cameras.length;
  process.stdout.write(`${result.cameras.length} kamera${result.degraded ? ' (degraded)' : ''}\n`);
}

if (failed >= Math.ceil(Object.keys(ROUTES).length / 2)) {
  throw new Error(
    'Lebih dari setengah sumber gagal. Snapshot lama dipertahankan; pastikan `npm run dev` berjalan atau set LENSAMAS_BASE.'
  );
}

writeFileSync(
  OUTPUT,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), sources })}\n`
);

const cameraCount = Object.values(sources).reduce((sum, list) => sum + list.length, 0);
process.stdout.write(`\nSnapshot ditulis: ${OUTPUT}\n`);
process.stdout.write(`Sumber: ${Object.keys(sources).length} | Kamera: ${cameraCount}\n`);
