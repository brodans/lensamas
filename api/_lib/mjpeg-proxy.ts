import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { redactLogMessage } from './request-log.js';
import {
  isContentUnavailable,
  sendCircuitResponse,
  sendContentUnavailable,
  sendStreamGatewayError,
} from './regional-hls.js';
import {
  noteStreamHealthy,
  noteStreamUnavailable,
  noteStreamUnreachable,
  streamCooldown,
} from './stream-circuit.js';

const DEFAULT_MAX_DURATION_MS = 30_000;
const MIN_MAX_DURATION_MS = 5_000;
const MAX_MAX_DURATION_MS = 120_000;

export interface MjpegProxyOptions {
  source: string;
  monitor: string;
  requestId: string;
  target: URL;
  expectedOrigin: string;
  pathPrefix: string;
  log: (level: 'info' | 'error', payload: Record<string, unknown>) => void;
}

function configuredDurationMs(): number {
  const raw = Number(process.env.MJPEG_MAX_DURATION_MS ?? DEFAULT_MAX_DURATION_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(MAX_MAX_DURATION_MS, Math.max(MIN_MAX_DURATION_MS, raw));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: message }));
}

function validRedirect(
  location: string | null,
  current: URL,
  expectedOrigin: string,
  pathPrefix: string
): URL | null {
  if (!location) return null;
  try {
    const next = new URL(location, current);
    if (next.origin !== expectedOrigin || !next.pathname.startsWith(pathPrefix)) return null;
    return next;
  } catch {
    return null;
  }
}

async function openMjpegResponse(
  target: URL,
  expectedOrigin: string,
  pathPrefix: string,
  signal: AbortSignal
): Promise<Response> {
  let current = target;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetch(current, {
      headers: {
        Accept: 'image/*,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'User-Agent': 'lensamas-cctv-proxy/1.0',
      },
      redirect: 'manual',
      signal,
    });
    if (response.status < 300 || response.status >= 400) return response;
    const next = validRedirect(response.headers.get('location'), current, expectedOrigin, pathPrefix);
    await response.body?.cancel().catch(() => undefined);
    if (!next) throw new Error('Redirect stream MJPEG tidak diizinkan.');
    current = next;
  }
  throw new Error('Terlalu banyak redirect stream MJPEG.');
}

function pipeMjpeg(response: Response, res: ServerResponse, onDone: () => void): void {
  if (!response.body) {
    onDone();
    res.end();
    return;
  }
  const upstream = Readable.fromWeb(response.body as any);
  res.once('close', () => upstream.destroy());
  upstream.once('end', onDone);
  upstream.once('error', () => {
    onDone();
    if (!res.writableEnded) res.end();
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders();
  upstream.pipe(res);
}

/**
 * Proxy MJPEG dengan validasi target, redirect same-origin, dan batas waktu
 * yang dapat dikonfigurasi. Credential hanya ada di request upstream server.
 */
export async function serveMjpegProxy(
  _req: IncomingMessage,
  res: ServerResponse,
  options: MjpegProxyOptions
): Promise<void> {
  const target = options.target;
  if (target.protocol !== 'https:' || target.origin !== options.expectedOrigin || !target.pathname.startsWith(options.pathPrefix)) {
    sendError(res, 500, 'Konfigurasi stream MJPEG tidak valid.');
    return;
  }

  const cooldown = streamCooldown(options.source, options.monitor);
  if (cooldown) {
    sendCircuitResponse(res, cooldown, `Stream MJPEG ${options.source} sedang tidak tersedia.`);
    return;
  }

  const controller = new AbortController();
  const durationMs = configuredDurationMs();
  const timeout = durationMs > 0 ? setTimeout(() => controller.abort(), durationMs) : null;
  const startedAt = Date.now();
  const done = (): void => {
    if (timeout) clearTimeout(timeout);
  };
  res.once('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    const response = await openMjpegResponse(target, options.expectedOrigin, options.pathPrefix, controller.signal);
    if (response.status >= 400) {
      await response.body?.cancel().catch(() => undefined);
      done();
      options.log('error', {
        event: 'stream-error',
        source: options.source,
        monitor: options.monitor,
        requestId: options.requestId,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      if (isContentUnavailable(response.status)) {
        noteStreamUnavailable(options.source, options.monitor);
        sendContentUnavailable(res, `Stream MJPEG ${options.source} tidak tersedia.`);
        return;
      }
      noteStreamUnreachable(options.source, options.monitor);
      sendStreamGatewayError(res, `Stream MJPEG ${options.source} membalas HTTP ${response.status}.`, {
        upstreamStatus: response.status,
      });
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    if (response.headers.get('content-length') === '0' ||
      (contentType.toLowerCase().includes('multipart/') && !/boundary=/i.test(contentType))) {
      await response.body?.cancel().catch(() => undefined);
      done();
      options.log('error', {
        event: 'stream-error',
        source: options.source,
        monitor: options.monitor,
        requestId: options.requestId,
        status: response.status,
        durationMs: Date.now() - startedAt,
        reason: 'empty-or-invalid-multipart',
      });
      sendError(res, 502, `Stream MJPEG ${options.source} tidak menghasilkan frame.`);
      return;
    }

    noteStreamHealthy(options.source, options.monitor);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType || 'multipart/x-mixed-replace');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    options.log('info', {
      event: 'stream-response',
      source: options.source,
      monitor: options.monitor,
      requestId: options.requestId,
      status: response.status,
      durationMs: Date.now() - startedAt,
      bounded: durationMs > 0,
    });
    pipeMjpeg(response, res, done);
  } catch (error) {
    done();
    if (!res.headersSent) {
      options.log('error', {
        event: 'stream-error',
        source: options.source,
        monitor: options.monitor,
        requestId: options.requestId,
        durationMs: Date.now() - startedAt,
        error: redactLogMessage(error instanceof Error ? error.message : 'upstream-error'),
      });
      noteStreamUnreachable(options.source, options.monitor);
      sendStreamGatewayError(res, `Proxy stream MJPEG ${options.source} gagal.`);
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}
