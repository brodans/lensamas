import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { PlayerPhase } from './types';

export interface MjpegPlayerHandle {
  getImage(): HTMLImageElement | null;
}

interface MjpegPlayerProps {
  url: string;
  label?: string;
  reloadKey?: number;
  disabled?: boolean;
  onPhase: (phase: PlayerPhase) => void;
  onError: (message: string) => void;
}

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
type ByteArray = Uint8Array<ArrayBufferLike>;
const HEADER_SEPARATOR = new Uint8Array([13, 10, 13, 10]);

function appendBytes(left: ByteArray, right: ByteArray): ByteArray {
  if (left.length === 0) {
    const result = new Uint8Array(new ArrayBuffer(right.length));
    result.set(right);
    return result;
  }
  if (right.length === 0) {
    const result = new Uint8Array(new ArrayBuffer(left.length));
    result.set(left);
    return result;
  }
  const result = new Uint8Array(new ArrayBuffer(left.length + right.length));
  result.set(left);
  result.set(right, left.length);
  return result;
}

function findBytes(haystack: ByteArray, needle: ByteArray, from = 0): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  for (let index = Math.max(0, from); index <= haystack.length - needle.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

function isJpegFrame(frame: ByteArray): boolean {
  return frame.length >= 4 && frame[0] === 0xff && frame[1] === 0xd8 && frame[frame.length - 2] === 0xff && frame[frame.length - 1] === 0xd9;
}

function trimFramePart(part: ByteArray): ByteArray {
  let start = 0;
  let end = part.length;
  while (start < end && (part[start] === 13 || part[start] === 10)) start += 1;
  while (end > start && (part[end - 1] === 13 || part[end - 1] === 10)) end -= 1;
  return part.slice(start, end);
}

async function readMultipartFrames(
  body: ReadableStream<Uint8Array>,
  boundary: string,
  onFrame: (frame: ByteArray) => void
): Promise<void> {
  const reader = body.getReader();
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  let pending: ByteArray = new Uint8Array(0);

  const consumePart = (part: Uint8Array): void => {
    const headerEnd = findBytes(part, HEADER_SEPARATOR);
    if (headerEnd < 0) return;
    const frame = trimFramePart(part.slice(headerEnd + HEADER_SEPARATOR.length));
    if (isJpegFrame(frame) && frame.length <= MAX_FRAME_BYTES) onFrame(frame);
  };

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      pending = appendBytes(pending, result.value);
      if (pending.length > MAX_FRAME_BYTES * 2) throw new Error('MJPEG frame terlalu besar.');

      for (;;) {
        const boundaryIndex = findBytes(pending, delimiter);
        if (boundaryIndex < 0) break;
        consumePart(pending.slice(0, boundaryIndex));
        pending = pending.slice(boundaryIndex + delimiter.length);
        if (pending[0] === 45 && pending[1] === 45) return;
        if (pending[0] === 13 && pending[1] === 10) pending = pending.slice(2);
      }
    }
    consumePart(pending);
  } finally {
    reader.releaseLock();
  }
}

async function readSnapshot(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: ByteArray) => void
): Promise<void> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > MAX_FRAME_BYTES) throw new Error('Snapshot MJPEG terlalu besar.');
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const frame = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    frame.set(chunk, offset);
    offset += chunk.length;
  }
  if (isJpegFrame(frame)) onFrame(frame);
}

/** Player untuk stream HTTP multipart MJPEG yang diproksi same-origin. */
const MjpegPlayer = forwardRef<MjpegPlayerHandle, MjpegPlayerProps>(
  ({ url, label = 'CCTV', reloadKey = 0, disabled = false, onPhase, onError }, ref) => {
    const imageRef = useRef<HTMLImageElement | null>(null);
    const objectUrlRef = useRef<string | null>(null);
    const phaseRef = useRef(onPhase);
    const errorRef = useRef(onError);

    useImperativeHandle(ref, () => ({
      getImage: () => imageRef.current,
    }));

    useEffect(() => {
      phaseRef.current = onPhase;
      errorRef.current = onError;
    }, [onError, onPhase]);

    useEffect(() => {
      const image = imageRef.current;
      if (disabled) return undefined;
      if (!image || !url) {
        phaseRef.current('error');
        errorRef.current('URL stream MJPEG tidak tersedia.');
        return undefined;
      }

      let alive = true;
      let retryTimer: number | null = null;
      let retryCount = 0;
      const controller = new AbortController();

      const clearRetry = (): void => {
        if (retryTimer !== null) {
          window.clearTimeout(retryTimer);
          retryTimer = null;
        }
      };

      const showFrame = (frame: Uint8Array): void => {
        if (!alive) return;
        const frameBuffer = new Uint8Array(new ArrayBuffer(frame.byteLength));
        frameBuffer.set(frame);
        const blob = new Blob([frameBuffer.buffer], { type: 'image/jpeg' });
        const nextUrl = URL.createObjectURL(blob);
        const previousUrl = objectUrlRef.current;
        objectUrlRef.current = nextUrl;
        image.src = nextUrl;
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        retryCount = 0;
        errorRef.current('');
        phaseRef.current('live');
      };

      const scheduleReconnect = (message: string): void => {
        if (!alive) return;
        errorRef.current(message);
        if (retryCount >= MAX_RETRIES) {
          phaseRef.current('error');
          return;
        }
        const delay = RETRY_BASE_MS * (2 ** retryCount);
        retryCount += 1;
        phaseRef.current('connecting');
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          void connect();
        }, delay);
      };

      const connect = async (): Promise<void> => {
        if (!alive) return;
        phaseRef.current('connecting');
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'same-origin',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const contentType = (response.headers.get('content-type') || '').toLowerCase();
          if (!response.body) throw new Error('Respons MJPEG tidak memiliki body.');
          const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1]?.replace(/^"|"$/g, '').trim();
          if (contentType.includes('multipart/') && boundary) {
            await readMultipartFrames(response.body, boundary, showFrame);
          } else if (contentType.startsWith('image/')) {
            await readSnapshot(response.body, showFrame);
          } else {
            throw new Error('Content-Type MJPEG tidak didukung.');
          }
          if (alive) scheduleReconnect(`Stream ${label} berakhir; mencoba menyambung ulang.`);
        } catch (error) {
          if (!alive || controller.signal.aborted) return;
          const message = error instanceof Error ? error.message : 'Kesalahan stream tidak diketahui.';
          scheduleReconnect(`Stream ${label} terputus (${message}).`);
        }
      };

      void connect();
      return () => {
        alive = false;
        clearRetry();
        controller.abort();
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = null;
        }
        image.removeAttribute('src');
      };
    }, [disabled, label, reloadKey, url]);

    return (
      <div className="mjpeg-wrap">
        <img
          key={reloadKey}
          ref={imageRef}
          className="mjpeg-image"
          alt={`Live stream ${label}`}
          draggable={false}
          decoding="async"
        />
      </div>
    );
  }
);

MjpegPlayer.displayName = 'MjpegPlayer';

export default MjpegPlayer;
