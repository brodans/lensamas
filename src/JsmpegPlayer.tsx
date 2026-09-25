import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { PlayerPhase } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    JSMpeg?: any;
  }
}

export interface JsmpegPlayerHandle {
  getCanvas(): HTMLCanvasElement | null;
}

interface JsmpegPlayerProps {
  url: string;
  /** Menaikkan nilai ini memaksa koneksi ulang ke stream. */
  reloadKey?: number;
  onPhase: (phase: PlayerPhase) => void;
  onError: (message: string) => void;
}

/** Memuat pustaka JSMpeg sekali saja (global `window.JSMpeg`). */
let jsmpegLoader: Promise<any> | null = null;
function loadJsmpeg(): Promise<any> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('JSMpeg hanya tersedia di browser.'));
  }
  if (window.JSMpeg) return Promise.resolve(window.JSMpeg);
  if (jsmpegLoader) return jsmpegLoader;

  jsmpegLoader = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      if (window.JSMpeg) {
        settled = true;
        resolve(window.JSMpeg);
      }
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      reject(new Error('Gagal memuat dekoder JSMpeg.'));
    };

    const existing = document.querySelector<HTMLScriptElement>('script[data-jsmpeg]');
    if (existing) {
      existing.addEventListener('load', settle, { once: true });
      existing.addEventListener('error', fail, { once: true });
      if (window.JSMpeg) settle();
      return;
    }

    const script = document.createElement('script');
    script.src = '/vendor/jsmpeg.min.js';
    script.async = true;
    script.dataset.jsmpeg = '1';
    script.onload = settle;
    script.onerror = fail;
    document.head.appendChild(script);
  }).catch((error) => {
    jsmpegLoader = null;
    document.querySelector<HTMLScriptElement>('script[data-jsmpeg]')?.remove();
    throw error;
  });

  return jsmpegLoader;
}

const MAX_RESTARTS = 6;
const STALL_TIMEOUT_MS = 15000;

/**
 * Pemutar CCTV Madiun (primary IP/fallback) berbasis JSMpeg + canvas.
 * Stream JSMPEG dikirim lewat WebSocket dan sering butuh waktu singkat
 * (producer ffmpeg cold-start), sehingga komponen ini otomatis melakukan
 * koneksi ulang secara berkala sampai gambar pertama diterima.
 */
const JsmpegPlayer = forwardRef<JsmpegPlayerHandle, JsmpegPlayerProps>(
  ({ url, reloadKey = 0, onPhase, onError }, ref) => {
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const playerRef = useRef<any>(null);
    const phaseRef = useRef<PlayerPhase>('connecting');

    const setPhase = useCallback(
      (phase: PlayerPhase) => {
        if (phaseRef.current === phase) return;
        phaseRef.current = phase;
        onPhase(phase);
      },
      [onPhase]
    );

    useImperativeHandle(ref, () => ({
      getCanvas: () => canvasRef.current,
    }));

    useEffect(() => {
      let alive = true;
      let restartTimer: number | null = null;
      let stallTimer: number | null = null;
      let attempts = 0;
      let gotFrame = false;

      const canvas = canvasRef.current;
      if (!canvas) return undefined;

      const clearTimers = (): void => {
        if (restartTimer !== null) window.clearTimeout(restartTimer);
        if (stallTimer !== null) window.clearTimeout(stallTimer);
        restartTimer = null;
        stallTimer = null;
      };

      const destroyPlayer = (): void => {
        const player = playerRef.current;
        playerRef.current = null;
        if (player) {
          try {
            player.destroy();
          } catch {
            /* dibersihkan internal */
          }
        }
      };

      const scheduleRestart = (delayMs: number): void => {
        if (!alive) return;
        if (restartTimer !== null) return;
        attempts += 1;
        if (attempts > MAX_RESTARTS) {
          setPhase('error');
          onError('Stream CCTV Madiun belum tersedia. Coba beberapa saat lagi.');
          return;
        }
        setPhase(gotFrame ? 'connecting' : 'connecting');
        restartTimer = window.setTimeout(() => {
          restartTimer = null;
          destroyPlayer();
          void start();
        }, delayMs);
      };

      const armStallWatchdog = (): void => {
        if (stallTimer !== null) window.clearTimeout(stallTimer);
        stallTimer = window.setTimeout(() => {
          // Belum ada frame dalam batas waktu -> anggap stream belum siap.
          destroyPlayer();
          scheduleRestart(1500);
        }, STALL_TIMEOUT_MS);
      };

      const start = async (): Promise<void> => {
        if (!alive) return;
        setPhase('connecting');

        let JSMpeg: any;
        try {
          JSMpeg = await loadJsmpeg();
        } catch (err) {
          if (alive) {
            setPhase('error');
            onError((err as Error).message);
          }
          return;
        }
        if (!alive || !canvasRef.current) return;

        try {
          const player = new JSMpeg.Player(url, {
            canvas: canvasRef.current,
            autoplay: true,
            audio: false,
            loop: false,
            streaming: true,
            disableGl: true,
            preserveDrawingBuffer: true,
            onVideoDecode: () => {
              if (!alive) return;
              gotFrame = true;
              attempts = 0;
              armStallWatchdog();
              setPhase('live');
            },
            onSourceEstablished: () => {
              if (alive) setPhase('connecting');
            },
            onSourceCompleted: () => {
              if (!alive) return;
              destroyPlayer();
              scheduleRestart(gotFrame ? 1200 : 2500);
            },
            onStalled: () => {
              if (!alive) return;
              destroyPlayer();
              scheduleRestart(1500);
            },
          });
          if (!alive) {
            try {
              player.destroy();
            } catch {
              /* noop */
            }
            return;
          }
          playerRef.current = player;
          armStallWatchdog();
        } catch (err) {
          if (alive) {
            destroyPlayer();
            scheduleRestart(2000);
            if (attempts > MAX_RESTARTS) onError((err as Error).message);
          }
        }
      };

      void start();

      return () => {
        alive = false;
        clearTimers();
        destroyPlayer();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, reloadKey]);

    useEffect(() => {
      return () => {
        // Setel ulang fase saat komponen dilepas
        phaseRef.current = 'connecting';
      };
    }, []);

    return (
      <div className="jsmpeg-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="jsmpeg-canvas"
          width={960}
          height={540}
          aria-label="Live stream CCTV Madiun"
        />
      </div>
    );
  }
);

JsmpegPlayer.displayName = 'JsmpegPlayer';

export default JsmpegPlayer;
