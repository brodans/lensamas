import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestLogContext {
  handler?: string;
  mode?: 'dev' | 'preview' | 'serverless';
  [key: string]: unknown;
}

export interface RequestLogState {
  requestId: string;
  setMeta: (meta: RequestLogContext) => void;
  setError: (error: unknown) => void;
}

function logAllEnabled(): boolean {
  return process.env.REQUEST_LOG_ALL === '1' || process.env.REQUEST_LOG_ALL === 'true';
}

function errorsOnly(): boolean {
  return process.env.REQUEST_LOG_LEVEL === 'error';
}

function logEnabled(): boolean {
  return !['0', 'false', 'off', 'no'].includes(
    (process.env.REQUEST_LOG || '1').trim().toLowerCase()
  );
}

function verboseLogs(): boolean {
  return process.env.REQUEST_LOG_VERBOSE === '1' || process.env.REQUEST_LOG_VERBOSE === 'true';
}

export function shouldWriteProviderLog(level: 'info' | 'error'): boolean {
  return logEnabled() && (!errorsOnly() || level === 'error');
}
const MEDIA_LOG_SAMPLE_MS = 2_000;
const mediaSampleAt = new Map<string, number>();

function isMediaRequest(url: string): boolean {
  try {
    const parsed = new URL(url, 'http://localhost');
    if (!parsed.pathname.startsWith('/api/')) return false;
    const mode = parsed.searchParams.get('mode')?.toLowerCase();
    return mode === 'hls' || mode === 'mjpeg' || parsed.pathname.endsWith('/sarangan-stream');
  } catch {
    return false;
  }
}

function mediaLogKey(url: string): string {
  try {
    const parsed = new URL(url, 'http://localhost');
    return `${parsed.pathname}?source=${parsed.searchParams.get('source') || ''}&mode=${parsed.searchParams.get('mode') || ''}`;
  } catch {
    return '/api/media';
  }
}

function allowMediaLog(url: string): boolean {
  if (logAllEnabled()) return true;
  const key = mediaLogKey(url);
  const now = Date.now();
  const last = mediaSampleAt.get(key) || 0;
  if (now - last < MEDIA_LOG_SAMPLE_MS) return false;
  mediaSampleAt.set(key, now);
  if (mediaSampleAt.size > 256) {
    for (const [key, timestamp] of mediaSampleAt) {
      if (now - timestamp >= MEDIA_LOG_SAMPLE_MS) mediaSampleAt.delete(key);
    }
  }
  return true;
}

function requestId(req: IncomingMessage): string {
  const supplied = req.headers['x-request-id'];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  if (value && /^[A-Za-z0-9._:-]{1,100}$/.test(value)) return value;
  return randomUUID();
}

const SENSITIVE_QUERY_KEY = /token|secret|password|passwd|authorization|cookie|session|sourcequery|source_query|signature|sig|jwt|key|^u$|^url$|^target$/i;

export function redactLogMessage(value: unknown): string {
  return String(value ?? '')
    .replace(/(?:https?|wss?|rtsp):\/\/[^\s"'<>]+/gi, '[UPSTREAM_URL]')
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/([?&](?:token|secret|password|passwd|authorization|cookie|session|sourcequery|source_query|signature|sig|jwt|key)=)[^&\s]+/gi, '$1[REDACTED]');
}

function redactQuery(url: URL): string {
  for (const key of [...url.searchParams.keys()]) {
    const values = url.searchParams.getAll(key);
    const containsUrl = values.some((value) => /(?:https?|wss?|rtsp):\/\//i.test(value));
    if (SENSITIVE_QUERY_KEY.test(key) || containsUrl) url.searchParams.set(key, '[REDACTED]');
  }
  return `${url.pathname}${url.search}`;
}

function requestPath(req: IncomingMessage): { path: string; url: string } {
  const raw = req.url || '/';
  try {
    const parsed = new URL(raw, 'http://localhost');
    return { path: parsed.pathname, url: redactQuery(parsed) };
  } catch {
    return { path: raw.split('?')[0] || '/', url: raw.split('?')[0] || '/' };
  }
}

function safeReferer(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  try {
    return redactQuery(new URL(raw, 'http://localhost'));
  } catch {
    return '[INVALID_REFERER]';
  }
}

function remoteAddress(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (value || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function errorInfo(error: unknown): { name: string; message: string; stack?: string } {
  const value = error instanceof Error ? error : new Error(String(error));
  const result: { name: string; message: string; stack?: string } = {
    name: value.name,
    message: redactLogMessage(value.message),
  };
  if (process.env.REQUEST_LOG_STACK === '1' && value.stack) result.stack = redactLogMessage(value.stack);
  return result;
}

function writeLog(level: 'info' | 'error', payload: Record<string, unknown>): void {
  const line = `[lensamas-request] ${JSON.stringify(payload)}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function shouldLog(path: string): boolean {
  return logEnabled() && (logAllEnabled() || path.startsWith('/api/'));
}

/**
 * Memulai log request server-side. Log tidak pernah menulis body, header auth,
 * cookie, atau nilai query sensitif; request ID tetap dikembalikan ke client.
 */
export function beginRequestLog(
  req: IncomingMessage,
  res: ServerResponse,
  context: RequestLogContext = {}
): RequestLogState | null {
  const { path, url } = requestPath(req);
  if (!shouldLog(path)) return null;
  const mediaRequest = isMediaRequest(url);
  const logMediaRequest = !mediaRequest || allowMediaLog(url);

  const id = requestId(req);
  const startedAt = Date.now();
  const meta: RequestLogContext = { ...context };
  const verbose = verboseLogs();
  let error: unknown;
  let finished = false;

  res.setHeader('X-Request-Id', id);
  if (!errorsOnly() && logMediaRequest) {
    writeLog('info', {
      event: 'start',
      requestId: id,
      method: req.method || 'UNKNOWN',
      path,
      url,
      ...(verbose ? {
        remote: remoteAddress(req),
        host: req.headers.host || null,
        userAgent: req.headers['user-agent'] || null,
        origin: req.headers.origin || null,
        referer: safeReferer(req.headers.referer),
        range: req.headers.range || null,
        requestContentLength: req.headers['content-length'] || null,
      } : {}),
      ...meta,
    });
  }

  const finish = (event: 'finish' | 'abort' = 'finish'): void => {
    if (finished) return;
    finished = true;
    const status = res.statusCode || 0;
    const durationMs = Date.now() - startedAt;
    const failed = Boolean(error) || status >= 400 || event === 'abort' || status === 0;
    const fallback = res.getHeader('x-lensamas-fallback') === '1';
    const stale = res.getHeader('x-lensamas-stale') === '1';
    const loggedError = error || (status >= 400 ? new Error(`HTTP ${status}`) : undefined);
    if ((!errorsOnly() || failed) && (logMediaRequest || failed)) {
      writeLog(failed ? 'error' : 'info', {
        event,
        outcome: event === 'abort' ? 'aborted' : failed ? 'error' : fallback ? 'fallback' : stale ? 'stale' : 'success',
        requestId: id,
        method: req.method || 'UNKNOWN',
        path,
        url,
        status,
        durationMs,
        contentLength: res.getHeader('content-length') || null,
        upstreamSource: res.getHeader('x-lensamas-source') || null,
        fallback,
        stale,
        ...(verbose ? {
          remote: remoteAddress(req),
          host: req.headers.host || null,
          userAgent: req.headers['user-agent'] || null,
          origin: req.headers.origin || null,
          referer: safeReferer(req.headers.referer),
          range: req.headers.range || null,
          requestContentLength: req.headers['content-length'] || null,
        } : {}),
        ...meta,
        ...(loggedError ? { error: errorInfo(loggedError) } : {}),
      });
    }
  };

  res.once('finish', () => finish('finish'));
  res.once('close', () => {
    if (!res.writableFinished) finish('abort');
  });

  return {
    requestId: id,
    setMeta: (next) => Object.assign(meta, next),
    setError: (next) => {
      error = next;
    },
  };
}
