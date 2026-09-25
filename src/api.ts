import type { ApiResponse, Camera, StreamResponseData, WifiPoint } from './types';

const STORAGE_CAMERAS = 'lensamas_offline_cameras';
const STORAGE_WIFI = 'lensamas_offline_wifi';
const STORAGE_SYNCED_AT = 'lensamas_offline_synced_at';

function migrateCachedCamera(camera: Camera): Camera {
  if (camera.source === 'magetan' && camera.streamUrl?.includes('/api/sarangan-stream?u=') && camera.sourceCode) {
    return {
      ...camera,
      streamUrl: `/api/sarangan-stream?${new URLSearchParams({ camera: camera.sourceCode, asset: 'file.m3u8' }).toString()}`,
    };
  }
  if (camera.source === 'trenggalek' && camera.streamUrl?.startsWith('http') && camera.sourceCode) {
    return {
      ...camera,
      streamUrl: `/api/hls-proxy?${new URLSearchParams({ source: 'trenggalek', mode: 'hls', camera: camera.sourceCode, asset: 'playlist.m3u8' }).toString()}`,
    };
  }
  if (camera.source === 'kediri' && camera.streamUrl?.startsWith('http') && camera.sourceCode) {
    return {
      ...camera,
      streamUrl: `/api/hls-proxy?${new URLSearchParams({ source: 'kediri', mode: 'hls', camera: camera.sourceCode, asset: 'index.m3u8' }).toString()}`,
    };
  }
  return camera;
}

function migrateCachedCameras(cameras: Camera[]): Camera[] {
  return cameras.map(migrateCachedCamera);
}

/**
 * Mengambil data CCTV tersimpan dari localStorage.
 */
export function getCachedCameras(): Camera[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_CAMERAS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? migrateCachedCameras(parsed as Camera[]) : [];
  } catch {
    return [];
  }
}

/**
 * Mengambil data WiFi tersimpan dari localStorage.
 */
export function getCachedWifi(): WifiPoint[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_WIFI);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Mengambil timestamp waktu sinkronisasi terakhir.
 */
export function getLastSyncTime(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(STORAGE_SYNCED_AT);
  } catch {
    return null;
  }
}

/**
 * Menyimpan data ke localStorage untuk ketahanan offline.
 */
export function saveOfflineData(cameras: Camera[], wifi: WifiPoint[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (Array.isArray(cameras) && cameras.length > 0) {
      localStorage.setItem(STORAGE_CAMERAS, JSON.stringify(cameras));
    }
    if (Array.isArray(wifi) && wifi.length > 0) {
      localStorage.setItem(STORAGE_WIFI, JSON.stringify(wifi));
    }
    localStorage.setItem(STORAGE_SYNCED_AT, new Date().toISOString());
  } catch {
    // Ignore storage quota limits
  }
}

/**
 * Mengubah pesan error teknis menjadi kalimat bahasa Indonesia yang ramah & profesional.
 */
export function formatApiErrorMessage(err: unknown): string {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return 'Koneksi internet perangkat Anda sedang offline.';
  }

  const raw = (err as Error)?.message || String(err || '');

  if (raw.includes('502') || raw.includes('Bad Gateway')) {
    return 'Server pusat (Nawasara) sedang tidak dapat dijangkau sementara waktu.';
  }
  if (raw.includes('503') || raw.includes('504') || raw.includes('Timeout') || raw.includes('timeout')) {
    return 'Server pusat sedang sibuk atau batas waktu koneksi habis.';
  }
  if (raw.includes('Failed to fetch') || raw.includes('NetworkError') || raw.includes('fetch')) {
    return 'Gagal terhubung ke server. Periksa koneksi internet Anda.';
  }

  return raw || 'Terjadi gangguan saat menghubungkan ke server data.';
}

/**
 * Mengambil daftar seluruh CCTV publik Ponorogo.
 */
export async function fetchCameras(signal?: AbortSignal): Promise<Camera[]> {
  let res: Response;
  try {
    res = await fetch('/api/cameras', { signal });
  } catch (netErr) {
    throw new Error(formatApiErrorMessage(netErr));
  }

  if (!res.ok) {
    if (res.status === 502) {
      throw new Error('Server pusat (Nawasara) sedang tidak dapat dijangkau sementara (HTTP 502).');
    }
    if (res.status === 503 || res.status === 504) {
      throw new Error('Server pusat sedang sibuk atau batas waktu habis.');
    }
    throw new Error(`Tidak dapat memuat daftar CCTV (HTTP ${res.status}).`);
  }

  const json = (await res.json()) as ApiResponse<Camera[]>;
  if (!Array.isArray(json.data)) {
    throw new Error('Format data kamera tidak dikenali dari server.');
  }
  return json.data;
}

/**
 * Mengambil titik hotspot WiFi publik Ponorogo.
 */
export async function fetchWifiPoints(signal?: AbortSignal): Promise<WifiPoint[]> {
  try {
    const res = await fetch('/api/wifi', { signal });
    if (!res.ok) return getCachedWifi();
    const json = (await res.json()) as ApiResponse<WifiPoint[]>;
    return Array.isArray(json.data) ? json.data : getCachedWifi();
  } catch {
    return getCachedWifi();
  }
}

export interface StreamUrlResult {
  wss: string;
  mode: string;
  expiresAt: Date | null;
}

/**
 * Meminta signed stream URL (masa berlaku ~5 menit) lalu mengubah https:// -> wss://
 * karena server go2rtc melayani stream live via WebSocket.
 */
export async function fetchStreamUrl(slug: string, signal?: AbortSignal): Promise<StreamUrlResult> {
  let res: Response;
  try {
    res = await fetch(`/api/stream/${encodeURIComponent(slug)}`, { signal });
  } catch (netErr) {
    throw new Error(formatApiErrorMessage(netErr));
  }

  if (!res.ok) {
    if (res.status === 502) {
      throw new Error('Server live stream go2rtc sedang tidak dapat dijangkau (HTTP 502). Coba sesaat lagi.');
    }
    if (res.status === 503 || res.status === 504) {
      throw new Error('Server live stream sedang sibuk. Silakan coba kembali.');
    }
    throw new Error(`Gagal membuka live stream kamera (HTTP ${res.status}).`);
  }

  const json = (await res.json()) as ApiResponse<StreamResponseData>;
  const data = json.data;
  if (!data?.stream_url) {
    throw new Error('Stream URL tidak ditemukan dalam respons API');
  }

  const wss = data.stream_url.replace(/^http/, 'ws');
  return {
    wss,
    mode: data.mode || 'mse',
    expiresAt: data.expires_at ? new Date(data.expires_at) : null,
  };
}

/**
 * Mengambil daftar CCTV Kota Madiun melalui proxy internal `/api/madiun`.
 * Server memprioritaskan sumber utama resmi pada IP Kota Madiun dan
 * otomatis memakai Villabs sebagai fallback. Fungsi ini selalu mengembalikan
 * array (fallback ke data tersimpan) sehingga kegagalan sumber tidak
 * menggagalkan pemuatan kamera Ponorogo.
 */
export async function fetchMadiunCameras(signal?: AbortSignal): Promise<Camera[]> {
  const cached = getCachedCameras().filter((c) => (c.source || 'ponorogo') === 'madiun');
  try {
    const res = await fetch('/api/madiun', { signal });
    if (!res.ok) return cached;
    const json = (await res.json()) as ApiResponse<Camera[]>;
    const list = Array.isArray(json.data) ? json.data : [];
    return list.length > 0 ? list : cached;
  } catch {
    return cached;
  }
}

/**
 * Mengambil daftar CCTV Kabupaten Magetan (sumber publik Sarangan Vision) lewat
 * proxy internal `/api/sarangan`. Deteksi online/offline dilakukan di sisi
 * server melalui probe manifest HLS, sehingga respons sudah memuat `status`.
 *
 * Fungsi ini selalu mengembalikan array (fallback ke data tersimpan) agar
 * kegagalan sumber Magetan tidak menggagalkan pemuatan kamera lain.
 */
export async function fetchMagetanCameras(signal?: AbortSignal): Promise<Camera[]> {
  const cached = getCachedCameras().filter((c) => (c.source || 'ponorogo') === 'magetan');
  try {
    const res = await fetch('/api/sarangan', { signal });
    if (!res.ok) return cached;
    const json = (await res.json()) as ApiResponse<Camera[]>;
    const list = Array.isArray(json.data) ? json.data : [];
    return list.length > 0 ? list : cached;
  } catch {
    return cached;
  }
}

/**
 * Mengambil daftar CCTV Kabupaten Trenggalek (GEOTIK) lewat proxy internal
 * `/api/trenggalek`. Endpoint GEOTIK diprioritaskan; portal TGX lama hanya
 * digunakan sebagai fallback ketika GeoJSON sedang tidak tersedia.
 *
 * Fungsi ini selalu mengembalikan array (fallback ke data tersimpan) agar
 * kegagalan sumber Trenggalek tidak menggagalkan pemuatan kamera lain.
 */
export async function fetchTrenggalekCameras(signal?: AbortSignal): Promise<Camera[]> {
  const cached = getCachedCameras().filter((c) => (c.source || 'ponorogo') === 'trenggalek');
  try {
    const res = await fetch('/api/trenggalek', { signal });
    if (!res.ok) return cached;
    const json = (await res.json()) as ApiResponse<Camera[]>;
    const list = Array.isArray(json.data) ? json.data : [];
    return list.length > 0 ? list : cached;
  } catch {
    return cached;
  }
}

export async function fetchKediriCameras(signal?: AbortSignal): Promise<Camera[]> {
  const cached = getCachedCameras().filter((camera) => camera.source === 'kediri');
  try {
    const res = await fetch('/api/kediri', { signal });
    if (!res.ok) return cached;
    const json = (await res.json()) as ApiResponse<Camera[]>;
    const list = Array.isArray(json.data) ? json.data : [];
    return list.length > 0 ? list : cached;
  } catch {
    return cached;
  }
}

export async function fetchTulungagungCameras(signal?: AbortSignal): Promise<Camera[]> {
  const cached = getCachedCameras().filter((camera) => camera.source === 'tulungagung');
  try {
    const res = await fetch('/api/tulungagung', { signal });
    if (!res.ok) return cached;
    const json = (await res.json()) as ApiResponse<Camera[]>;
    const list = Array.isArray(json.data) ? json.data : [];
    return list.length > 0 ? list : cached;
  } catch {
    return cached;
  }
}

export async function fetchMalangCameras(signal?: AbortSignal): Promise<Camera[]> {
  const cached = getCachedCameras().filter((camera) => camera.source === 'malang');
  try {
    const res = await fetch('/api/malang', { signal });
    if (!res.ok) return cached;
    const json = (await res.json()) as ApiResponse<Camera[]>;
    const list = Array.isArray(json.data) ? json.data : [];
    return list.length > 0 ? list : cached;
  } catch {
    return cached;
  }
}

export async function fetchMojokertoCameras(signal?: AbortSignal): Promise<Camera[]> {
  const cached = getCachedCameras().filter((camera) => camera.source === 'mojokerto');
  try {
    const res = await fetch('/api/mojokerto', { signal });
    if (!res.ok) return cached;
    const json = (await res.json()) as ApiResponse<Camera[]>;
    const list = Array.isArray(json.data) ? json.data : [];
    return list.length > 0 ? list : cached;
  } catch {
    return cached;
  }
}

export async function fetchSurabayaCameras(signal?: AbortSignal): Promise<Camera[]> {
  const cached = getCachedCameras().filter((camera) => camera.source === 'surabaya');
  try {
    const res = await fetch('/api/hls-proxy?source=surabaya&mode=list', { signal });
    if (!res.ok) return cached;
    const json = (await res.json()) as ApiResponse<Camera[]>;
    const list = Array.isArray(json.data) ? json.data : [];
    return list.length > 0 ? list : cached;
  } catch {
    return cached;
  }
}

export async function fetchBojonegoroCameras(signal?: AbortSignal): Promise<Camera[]> {
  const cached = getCachedCameras().filter((camera) => camera.source === 'bojonegoro');
  try {
    const res = await fetch('/api/hls-proxy?source=bojonegoro&mode=list', { signal });
    if (!res.ok) return cached;
    const json = (await res.json()) as ApiResponse<Camera[]>;
    const list = Array.isArray(json.data) ? json.data : [];
    return list.length > 0 ? list : cached;
  } catch {
    return cached;
  }
}

export async function fetchGresikCameras(signal?: AbortSignal): Promise<Camera[]> {
  const cached = getCachedCameras().filter((camera) => camera.source === 'gresik');
  try {
    const res = await fetch('/api/hls-proxy?source=gresik&mode=list', { signal });
    if (!res.ok) return cached;
    const json = (await res.json()) as ApiResponse<Camera[]>;
    const list = Array.isArray(json.data) ? json.data : [];
    return list.length > 0 ? list : cached;
  } catch {
    return cached;
  }
}

export async function fetchTubanCameras(signal?: AbortSignal): Promise<Camera[]> {
  return fetchRegionalCameras('tuban', signal);
}

async function fetchRegionalCameras(source: string, signal?: AbortSignal): Promise<Camera[]> {
  const cached = getCachedCameras().filter((camera) => camera.source === source);
  try {
    const res = await fetch(`/api/hls-proxy?source=${encodeURIComponent(source)}&mode=list`, { signal });
    if (!res.ok) return cached;
    const json = (await res.json()) as ApiResponse<Camera[]>;
    const list = Array.isArray(json.data) ? json.data : [];
    return list.length > 0 ? list : cached;
  } catch {
    return cached;
  }
}

export async function fetchBanyuwangiCameras(signal?: AbortSignal): Promise<Camera[]> {
  return fetchRegionalCameras('banyuwangi', signal);
}

export async function fetchBondowosoCameras(signal?: AbortSignal): Promise<Camera[]> {
  return fetchRegionalCameras('bondowoso', signal);
}

export async function fetchSitubondoCameras(signal?: AbortSignal): Promise<Camera[]> {
  return fetchRegionalCameras('situbondo', signal);
}

export async function fetchPasuruanCameras(signal?: AbortSignal): Promise<Camera[]> {
  return fetchRegionalCameras('pasuruan', signal);
}

export async function startSurabayaStream(cameraId: string, streamUrl?: string): Promise<void> {
  const res = await fetch('/api/hls-proxy?source=surabaya&mode=start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cameraId }),
  });
  if (!res.ok) {
    let message = `Gagal memulai stream Surabaya (HTTP ${res.status}).`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the HTTP fallback message.
    }
    throw new Error(message);
  }

  // Start Sometimes kembali sebelum manifest HLS siap. Polling singkat ini
  // mencegah Hls.js melihat 404 pertama sebagai kegagalan permanen, tanpa
  // membuat banyak permintaan gagal bila upstream tidak merespons.
  if (!streamUrl) return;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const manifest = await fetch(streamUrl, { cache: 'no-store' });
      if (manifest.ok) {
        await manifest.text();
        return;
      }
      // 4xx berarti kamera tidak tersedia; mencoba lagi tidak akan mengubahnya.
      if (manifest.status >= 400 && manifest.status < 500) break;
    } catch {
      // Retry melalui proxy yang sama.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 900));
  }
  throw new Error('Stream Surabaya belum siap. Coba kembali beberapa saat lagi.');
}

export function stopSurabayaStream(cameraId: string): void {
  void fetch('/api/hls-proxy?source=surabaya&mode=stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cameraId }),
    keepalive: true,
  }).catch(() => undefined);
}

function createGresikViewerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

async function gresikAction(
  mode: 'start' | 'heartbeat' | 'stop',
  cameraId: string,
  viewerId: string
): Promise<void> {
  const response = await fetch(`/api/hls-proxy?source=gresik&mode=${mode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cameraId, viewerId }),
    keepalive: mode === 'stop',
  });
  if (!response.ok) {
    throw new Error(`Aksi ${mode} stream Gresik gagal (HTTP ${response.status}).`);
  }
}

export async function startGresikStream(cameraId: string): Promise<string> {
  const viewerId = createGresikViewerId();
  await gresikAction('start', cameraId, viewerId);
  return viewerId;
}

export function heartbeatGresikStream(cameraId: string, viewerId: string): void {
  void gresikAction('heartbeat', cameraId, viewerId).catch(() => undefined);
}

export function stopGresikStream(cameraId: string, viewerId: string): void {
  void gresikAction('stop', cameraId, viewerId).catch(() => undefined);
}
