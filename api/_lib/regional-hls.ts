import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export const REGIONAL_MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
export const REGIONAL_REQUEST_TIMEOUT_MS = 12_000;

export function setRegionalGetCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Lensamas-Source');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

export function sendRegionalJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Status upstream yang berarti "konten tidak tersedia untuk klien", bukan
 * kegagalan gateway kita: 404/410 = tidak ada, 401/403 = upstream menolak.
 * Membalas 404 lebih jujur daripada 502, tidak membocorkan state autentikasi
 * upstream, dan tidak dihitung sebagai server error.
 */
const CONTENT_UNAVAILABLE_STATUS = new Set([401, 403, 404, 410, 451]);

export function isContentUnavailable(status: number): boolean {
  return CONTENT_UNAVAILABLE_STATUS.has(status);
}

/** 401/403 upstream dicatat sebagai `forbidden` agar tidak menandai kamera mati. */
export function streamHealthForStatus(status: number): 'unavailable' | 'forbidden' | 'unreachable' {
  if (status === 401 || status === 403) return 'forbidden';
  if (isContentUnavailable(status)) return 'unavailable';
  return 'unreachable';
}

/** Pemetaan status upstream ke status respons Lensamas. */
export function mapUpstreamStatus(status: number): number {
  return isContentUnavailable(status) ? 404 : 502;
}

/** 404 perlu cache pendek agar CDN menyerap percobaan ulang yang beruntun. */
export const UNAVAILABLE_CACHE_CONTROL = 'public, max-age=10, s-maxage=30, stale-while-revalidate=120';

function sendStreamStatus(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Lensamas-Stream', status === 404 ? 'unavailable' : 'unreachable');
  res.setHeader('Cache-Control', status === 404 ? UNAVAILABLE_CACHE_CONTROL : 'no-store');
  res.end(JSON.stringify(body));
}

/** Stream/manifest tidak tersedia di upstream. Balas 404, bukan 502. */
export function sendContentUnavailable(res: ServerResponse, message: string, extra: Record<string, unknown> = {}): void {
  sendStreamStatus(res, 404, { error: message, ...extra });
}

/**
 * Kegagalan saat menghubungi upstream. Status 404/410/451 dipetakan ke 404,
 * sisanya 502 karena itu memang kegagalan gateway.
 */
export function sendUpstreamStreamError(
  res: ServerResponse,
  upstreamStatus: number,
  message: string,
  extra: Record<string, unknown> = {}
): void {
  sendStreamStatus(res, mapUpstreamStatus(upstreamStatus), { error: message, ...extra });
}

/** Kegagalan murni dari sisi proxy (timeout, socket, TLS, proses). Tetap 502. */
export function sendStreamGatewayError(
  res: ServerResponse,
  message: string,
  extra: Record<string, unknown> = {}
): void {
  sendStreamStatus(res, 502, { error: message, ...extra });
}

/** Menjawab status simpanan dari sirkuit tanpa memanggil upstream lagi. */
export function sendCircuitResponse(
  res: ServerResponse,
  health: 'unavailable' | 'unreachable' | 'forbidden',
  message: string
): void {
  if (health === 'unreachable') {
    sendStreamGatewayError(res, message);
    return;
  }
  sendContentUnavailable(res, message);
}

/** Cache list pendek untuk respons degraded agar CDN tidak membanjiri origin. */
export const DEGRADED_LIST_CACHE_CONTROL = 'public, max-age=15, s-maxage=60, stale-while-revalidate=600';

/** Jeda sebelum sumber CCTV dicoba lagi setelah upstream gagal. */
const UPSTREAM_COOLDOWN_MS = 45_000;
const upstreamCooldowns = new Map<string, number>();

export function markUpstreamCooldown(source: string): void {
  upstreamCooldowns.set(source, Date.now() + UPSTREAM_COOLDOWN_MS);
  if (upstreamCooldowns.size > 64) {
    const now = Date.now();
    for (const [key, until] of upstreamCooldowns) {
      if (until <= now) upstreamCooldowns.delete(key);
    }
  }
}

export function isUpstreamCoolingDown(source: string): boolean {
  const until = upstreamCooldowns.get(source);
  if (!until) return false;
  if (until <= Date.now()) {
    upstreamCooldowns.delete(source);
    return false;
  }
  return true;
}

/**
 * Respons list ketika upstream tidak dapat dihubungi. Tetap 200 dengan data
 * terakhir yang diketahui baik supaya peta tetap utuh dan tidak ada 5xx yang
 * berasal dari masalah pihak ketiga.
 */
export function sendDegradedList(
  res: ServerResponse,
  source: string,
  data: unknown[],
  reason?: string
): void {
  markUpstreamCooldown(source);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', DEGRADED_LIST_CACHE_CONTROL);
  res.setHeader('X-Lensamas-Data', 'stale');
  res.setHeader('X-Lensamas-Stale', '1');
  res.setHeader('X-Lensamas-Degraded', '1');
  res.end(JSON.stringify({ data, source, stale: true, ...(reason ? { reason } : {}) }));
}

export function regionalTarget(baseUrl: URL, path: string, sourceName: string): URL {
  const target = new URL(path, baseUrl);
  if (target.origin !== baseUrl.origin) {
    throw new Error(`Path ${sourceName} di luar origin yang diizinkan.`);
  }
  return target;
}

export function regionalHeaders(userAgent: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': userAgent,
    ...extra,
  };
}

export async function readRegionalText(
  response: Response,
  maxBytes: number,
  label: string
): Promise<string> {
  const text = await response.text();
  if (text.length > maxBytes) throw new Error(`Respons ${label} terlalu besar.`);
  return text;
}

export function safeRegionalAsset(value: string, allowSlash = false): boolean {
  if (!value || value.length > 512 || value.includes('\\') || value.includes('..')) return false;
  if (value.startsWith('/')) return false;
  if (!allowSlash) return /^[A-Za-z0-9._-]+$/.test(value);
  return /^[A-Za-z0-9._/-]+$/.test(value) && !value.split('/').some((part) => !part || part === '.' || part === '..');
}

export function rewriteRegionalPlaylist(
  text: string,
  sourceUrl: URL,
  resolve: (absolute: URL) => string | null
): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (original, uri: string) => {
          try {
            const replacement = resolve(new URL(uri, sourceUrl));
            return replacement ? `URI="${replacement.replace(/"/g, '%22')}"` : original;
          } catch {
            return original;
          }
        });
      }
      try {
        return resolve(new URL(trimmed, sourceUrl)) || line;
      } catch {
        return line;
      }
    })
    .join('\n');
}

export function pipeRegionalBinary(response: Response, res: ServerResponse): void {
  if (!response.body) {
    res.end();
    return;
  }
  const upstream = Readable.fromWeb(response.body as any);
  res.on('close', () => upstream.destroy());
  upstream.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders();
  upstream.pipe(res);
}
