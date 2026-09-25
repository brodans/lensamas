import snapshotFile from './snapshots.json' with { type: 'json' };

/**
 * Bentuk minimum kamera pada snapshot. Field per sumber bisa lebih banyak,
 * jadi sisanya dibiarkan terbuka agar tidak perlu diubah tiap kali upstream
 * menambah field baru.
 */
export interface SnapshotCamera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status?: string;
  device_status?: string;
  source?: string;
  protocol?: string;
  streamUrl?: string;
  fallbackStreamUrl?: string;
  sourceCode?: string;
  code?: string;
  channel?: number;
  codec?: string;
  category?: string;
  cameraType?: string;
  group?: string;
  district?: string;
  streamConfigured?: boolean;
}

const SOURCES = snapshotFile.sources as unknown as Record<string, SnapshotCamera[]>;

/** Waktu refresh snapshot terakhir, hanya untuk diagnostik. */
export const snapshotGeneratedAt: string = snapshotFile.generatedAt;

/** Kamera terakhir yang diketahui baik untuk sebuah sumber (bisa kosong). */
export function snapshotCameras(source: string): SnapshotCamera[] {
  return SOURCES[source] || [];
}

export function hasSnapshot(source: string): boolean {
  return (SOURCES[source]?.length || 0) > 0;
}

/**
 * Cache awal untuk list sumber. `ts: 0` berarti dianggap basi sehingga
 * permintaan pertama tetap mencoba upstream; bila upstream gagal, snapshot
 * inilah yang dikirim dengan status 200 (bukan 5xx).
 */
export function seedListCache<T>(source: string): { ts: number; cameras: T[] } | null {
  const cameras = SOURCES[source];
  if (!cameras || cameras.length === 0) return null;
  return { ts: 0, cameras: cameras as unknown as T[] };
}
