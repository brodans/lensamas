/**
 * Sirkuit untuk stream CCTV.
 *
 * Tujuan:
 * 1. Tidak memukul upstream yang sudah pasti mati. Satu kegagalan streaming
 *    dicatat, lalu permintaan berikutnya dijawab dari memori selama cooldown
 *    sehingga permintaan serupa tidak berulang ke upstream.
 * 2. Menandai kamera yang gagal streaming sebagai `offline` pada respons list
 *    sehingga klien tidak mengirim permintaan stream lagi.
 */
import { streamHealthForStatus } from './regional-hls.js';

export type StreamHealth = 'unavailable' | 'unreachable' | 'forbidden';

interface CircuitEntry {
  health: StreamHealth;
  cooldownUntil: number;
  offlineUntil: number;
}

/**
 * `unavailable` = upstream memang menjawab tidak ada (404/410). Kamera
 * dianggap mati lebih lama karena upstream pemerintah sering offline lama.
 * `unreachable` = timeout/socket error, biasanya pulih dalam hitungan menit.
 * `forbidden` = upstream menolak akses (401/403). Penyebabnya bisa cookie atau
 * sesi kedaluwarsa, jadi cooldown-nya pendek dan kamera TIDAK ditandai offline.
 */
const COOLDOWN_MS: Record<StreamHealth, number> = {
  unavailable: 60_000,
  unreachable: 15_000,
  forbidden: 20_000,
};

/** Lama kamera ditandai `offline` pada respons list setelah gagal streaming. */
const OFFLINE_MARK_MS: Record<StreamHealth, number> = {
  unavailable: 30 * 60_000,
  unreachable: 5 * 60_000,
  forbidden: 0,
};

const MAX_ENTRIES = 4096;
const entries = new Map<string, CircuitEntry>();

function circuitKey(source: string, cameraId: string): string {
  return `${source}:${cameraId}`;
}

function prune(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.cooldownUntil <= now && entry.offlineUntil <= now) entries.delete(key);
  }
}

function set(source: string, cameraId: string, health: StreamHealth): void {
  if (!source || !cameraId) return;
  const now = Date.now();
  if (entries.size >= MAX_ENTRIES) {
    prune(now);
    if (entries.size >= MAX_ENTRIES) entries.clear();
  }
  const key = circuitKey(source, cameraId);
  const previous = entries.get(key);
  entries.set(key, {
    // Status yang lebih parah tidak diturunkan oleh error yang lebih ringan.
    health: previous?.health === 'unavailable' ? 'unavailable' : health,
    cooldownUntil: now + COOLDOWN_MS[health],
    offlineUntil: Math.max(previous?.offlineUntil || 0, now + OFFLINE_MARK_MS[health]),
  });
}

/** Catat upstream tidak menyediakan stream untuk kamera ini. */
export function noteStreamUnavailable(source: string, cameraId: string): void {
  set(source, cameraId, 'unavailable');
}

/** Catat upstream tidak dapat dihubungi (timeout, socket, TLS, atau 5xx). */
export function noteStreamUnreachable(source: string, cameraId: string): void {
  set(source, cameraId, 'unreachable');
}

/**
 * Catat upstream menolak akses (401/403). Tidak menandai kamera offline karena
 * penyebabnya sering sesi/cookie kedaluwarsa yang akan pulih sendiri.
 */
export function noteStreamForbidden(source: string, cameraId: string): void {
  set(source, cameraId, 'forbidden');
}

/**
 * Catat hasil upstream non-2xx dan pilih cooldown yang tepat:
 * 404/410 = kamera tidak ada, 401/403 = akses ditolak, lainnya tidak terjangkau.
 */
export function noteUpstreamStatus(source: string, cameraId: string, status: number): void {
  set(source, cameraId, streamHealthForStatus(status));
}

/** Stream sehat: lepaskan cooldown dan tanda offline. */
export function noteStreamHealthy(source: string, cameraId: string): void {
  entries.delete(circuitKey(source, cameraId));
}

function read(source: string, cameraId: string): CircuitEntry | null {
  if (!source || !cameraId) return null;
  const key = circuitKey(source, cameraId);
  const entry = entries.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (entry.cooldownUntil <= now && entry.offlineUntil <= now) {
    entries.delete(key);
    return null;
  }
  return entry;
}

/**
 * Status kesehatan yang masih berlaku, atau `null` bila upstream perlu
 * dicoba lagi. Dipakai handler stream untuk menjawab tanpa memanggil upstream.
 */
export function streamCooldown(source: string, cameraId: string): StreamHealth | null {
  const entry = read(source, cameraId);
  if (!entry) return null;
  return entry.cooldownUntil > Date.now() ? entry.health : null;
}

/** `true` bila kamera diketahui gagal belakangan ini dan layak ditandai offline. */
export function isMarkedOffline(source: string, cameraId: string): boolean {
  const entry = read(source, cameraId);
  return Boolean(entry && entry.offlineUntil > Date.now());
}

interface MarkableCamera {
  slug?: string;
  sourceCode?: string | number;
  code?: string | number;
  status?: string;
}

/** Semua ID yang bisa dipakai list untuk mengenali sebuah kamera. */
function listIds(camera: MarkableCamera): string[] {
  const ids: string[] = [];
  if (camera.sourceCode !== undefined && camera.sourceCode !== null) ids.push(String(camera.sourceCode));
  if (camera.code !== undefined && camera.code !== null) ids.push(String(camera.code));
  if (camera.slug) ids.push(camera.slug);
  return ids;
}

/**
 * Tandai kamera yang gagal streaming sebagai `offline` pada respons list.
 * Klien lalu tidak mengirim permintaan stream untuk kamera tersebut, sehingga
 * error rate tidak berlipat setiap kali pengguna membuka peta.
 */
export function markOfflineCameras<T extends MarkableCamera>(source: string, cameras: T[]): T[] {
  let changed = false;
  const output = cameras.map((camera) => {
    if (camera.status === 'offline') return camera;
    if (!listIds(camera).some((id) => isMarkedOffline(source, id))) return camera;
    changed = true;
    return { ...camera, status: 'offline' };
  });
  return changed ? output : cameras;
}
