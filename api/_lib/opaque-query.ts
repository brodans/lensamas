import { randomUUID } from 'node:crypto';

interface OpaqueQueryEntry {
  value: string;
  expiresAt: number;
}

const QUERY_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 8192;
const entries = new Map<string, OpaqueQueryEntry>();

function prune(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
  while (entries.size > MAX_ENTRIES) {
    const first = entries.keys().next().value;
    if (!first) break;
    entries.delete(first);
  }
}

/** Store a short-lived upstream query server-side and return an opaque ID. */
export function rememberOpaqueQuery(scope: string, value: string): string {
  const now = Date.now();
  prune(now);
  const id = randomUUID();
  entries.set(`${scope}:${id}`, { value, expiresAt: now + QUERY_TTL_MS });
  return id;
}

/** Read an opaque query without ever placing its value in a browser URL/log. */
export function readOpaqueQuery(scope: string, id: string | null): string {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return '';
  const entry = entries.get(`${scope}:${id}`);
  if (!entry || entry.expiresAt <= Date.now()) {
    entries.delete(`${scope}:${id}`);
    return '';
  }
  return entry.value;
}
