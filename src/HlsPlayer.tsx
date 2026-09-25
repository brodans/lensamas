import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import type { PlayerPhase } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HlsPlayerHandle {
  getVideo(): HTMLVideoElement | null;
}

interface HlsPlayerProps {
  url: string;
  /** URL langsung sebagai cadangan bila proxy same-origin ditolak/diblokir upstream. */
  fallbackUrl?: string;
  /** Gunakan URL langsung lebih dulu pada browser MSE; iOS native tetap memakai proxy. */
  preferFallbackOnMse?: boolean;
  /** Label sumber untuk pesan galat, mis. 'CCTV Magetan' atau 'CCTV Trenggalek'. */
  label?: string;
  /** Menaikkan nilai ini memaksa koneksi ulang ke stream. */
  reloadKey?: number;
  onPhase: (phase: PlayerPhase) => void;
  onError: (message: string) => void;
}

/** Memuat chunk hls.js terverifikasi dari package lock, bukan script global lama. */
type HlsConstructor = typeof import('hls.js').default;
let hlsLoader: Promise<HlsConstructor> | null = null;
function loadHls(): Promise<HlsConstructor> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('hls.js hanya tersedia di browser.'));
  }
  if (!hlsLoader) {
    hlsLoader = import('hls.js')
      .then((module) => module.default)
      .catch((error) => {
        hlsLoader = null;
        throw error;
      });
  }
  return hlsLoader;
}

const MAX_RESTARTS = 4;
const STALL_TIMEOUT_MS = 15_000;
/**
 * 404/410/451 dari upstream berarti kamera memang tidak tersedia. Mencoba
 * ulang tidak akan pernah berhasil dan hanya menambah permintaan gagal, jadi
 * pemutar langsung berhenti dengan pesan yang jelas.
 */
function isPermanentStreamStatus(data: any): boolean {
  const code = Number(data?.response?.code || data?.response?.networkDetails?.statusCode || 0);
  return code === 404 || code === 410 || code === 451;
}

/**
 * Pemutar CCTV HLS untuk seluruh sumber same-origin/proxy.
 * Safari/iOS memakai HLS native; browser lain memakai hls.js. Tombol putar
 * eksplisit tersedia sebagai fallback ketika autoplay mobile diblokir.
 */
const HlsPlayer = forwardRef<HlsPlayerHandle, HlsPlayerProps>(
  ({ url, fallbackUrl, preferFallbackOnMse = false, label = 'CCTV', reloadKey = 0, onPhase, onError }, ref) => {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const hlsRef = useRef<any>(null);
    const phaseRef = useRef<PlayerPhase>('connecting');
    const requestPlayRef = useRef<() => Promise<void>>(async () => {});
    const [needsPlay, setNeedsPlay] = useState(false);

    const requestPlay = useCallback(async (): Promise<void> => {
      await requestPlayRef.current();
    }, []);

    const togglePlayback = useCallback((): void => {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) void requestPlayRef.current();
      else video.pause();
    }, []);

    const setPhase = useCallback(
      (phase: PlayerPhase) => {
        if (phaseRef.current === phase) return;
        phaseRef.current = phase;
        onPhase(phase);
      },
      [onPhase]
    );

    useImperativeHandle(ref, () => ({
      getVideo: () => videoRef.current,
    }));

    useEffect(() => {
      let alive = true;
      let stallTimer: number | null = null;
      let restartTimer: number | null = null;
      let attempts = 0;
      let gotFrame = false;
      let usingFallback = false;
      let lastProgressTime = 0;

      const video = videoRef.current;
      if (!video || !url) return undefined;

      const clearStall = (): void => {
        if (stallTimer !== null) window.clearTimeout(stallTimer);
        stallTimer = null;
      };
      const clearRestart = (): void => {
        if (restartTimer !== null) window.clearTimeout(restartTimer);
        restartTimer = null;
      };

      const destroyHls = (): void => {
        const instance = hlsRef.current;
        hlsRef.current = null;
        if (instance) {
          try {
            instance.destroy();
          } catch {
            /* dibersihkan internal */
          }
        }
      };

      const markFrameAvailable = (): void => {
        if (!alive) return;
        gotFrame = true;
        attempts = 0;
        lastProgressTime = video.currentTime;
        setPhase('live');
        armStallWatchdog();
      };

      const requestPlay = async (): Promise<void> => {
        if (!alive) return;
        try {
          await video.play();
          if (!alive) return;
          setNeedsPlay(false);
          setPhase(video.readyState >= 2 && video.videoWidth > 0 ? 'live' : 'connecting');
          armStallWatchdog();
        } catch {
          if (!alive) return;
          // Autoplay policy pada iOS/Android dan embedded WebView dapat
          // menolak play() meski muted. Tombol overlay tetap dapat disentuh.
          setNeedsPlay(true);
          setPhase('connecting');
        }
      };
      requestPlayRef.current = requestPlay;

      const handleLoadedData = (): void => {
        if (!alive) return;
        gotFrame = true;
        setPhase('live');
        armStallWatchdog();
      };
      const handlePlaying = (): void => {
        if (!alive) return;
        setNeedsPlay(false);
        markFrameAvailable();
      };
      const handlePause = (): void => {
        if (alive && !video.ended) setNeedsPlay(true);
      };
      const handleVideoError = (): void => {
        if (!alive) return;
        destroyHls();
        if (fallbackUrl) usingFallback = !usingFallback;
        scheduleRestart(800);
      };

      const armStallWatchdog = (): void => {
        clearStall();
        lastProgressTime = video.currentTime;
        stallTimer = window.setTimeout(() => {
          if (!alive) return;
          if (!gotFrame && video.readyState < 2) {
            destroyHls();
            if (fallbackUrl) usingFallback = !usingFallback;
            scheduleRestart(500);
            return;
          }
          if (video.paused) {
            setNeedsPlay(true);
            armStallWatchdog();
            return;
          }
          if (gotFrame && video.readyState >= 2 && video.currentTime > lastProgressTime + 0.25) {
            armStallWatchdog();
            return;
          }
          destroyHls();
          scheduleRestart(1500);
        }, STALL_TIMEOUT_MS);
      };

      const scheduleRestart = (delayMs: number): void => {
        if (!alive || restartTimer !== null) return;
        attempts += 1;
        if (attempts > MAX_RESTARTS) {
          setPhase('error');
          onError(`Stream ${label} belum tersedia. Periksa koneksi lalu coba kembali.`);
          return;
        }
        setPhase('connecting');
        // Backoff eksponensial: kamera yang mati tidak boleh menghasilkan
        // permintaan gagal tanpa henti.
        const delay = Math.min(8000, delayMs * 2 ** (attempts - 1));
        restartTimer = window.setTimeout(() => {
          restartTimer = null;
          destroyHls();
          void start(usingFallback);
        }, delay);
      };
      const start = async (requestedDirectMode: boolean | null): Promise<void> => {
        if (!alive) return;
        if (!url) {
          setPhase('error');
          onError(`URL stream ${label} tidak tersedia.`);
          return;
        }

        setPhase('connecting');
        setNeedsPlay(false);
        gotFrame = false;
        clearStall();

        const canPlayNativeHls =
          typeof video.canPlayType === 'function' &&
          (video.canPlayType('application/vnd.apple.mpegurl') !== '' ||
            video.canPlayType('application/x-mpegURL') !== '');
        const supportsMse = 'MediaSource' in window || 'ManagedMediaSource' in window;
        const appleWebKit =
          /iPhone|iPad|iPod/.test(navigator.userAgent) ||
          (/Macintosh/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR/.test(navigator.userAgent));
        const nativeHls = canPlayNativeHls && (appleWebKit || !supportsMse);
        usingFallback = requestedDirectMode === null
          ? Boolean(preferFallbackOnMse && fallbackUrl && !nativeHls)
          : Boolean(requestedDirectMode && fallbackUrl);
        const sourceUrl = usingFallback && fallbackUrl ? fallbackUrl : url;

        // Safari/iOS paling stabil memakai HLS native. Jangan memuat hls.js
        // besar lebih dulu atau mengembalikan blank karena MSE tidak tersedia.
        if (nativeHls) {
          video.src = sourceUrl;
          video.load();
          void requestPlay();
          armStallWatchdog();
          return;
        }

        let Hls: any;
        try {
          Hls = await loadHls();
        } catch (error) {
          if (alive) {
            setPhase('error');
            onError((error as Error).message);
          }
          return;
        }
        if (!alive || !videoRef.current) return;

        if (!Hls?.isSupported?.()) {
          setPhase('error');
          onError('Peramban ini tidak mendukung pemutaran HLS.');
          return;
        }

        const hls = new Hls({
          debug: import.meta.env.DEV,
          lowLatencyMode: false,
          enableWorker: true,
          backBufferLength: 30,
          liveSyncDurationCount: 3,
          manifestLoadingTimeOut: 8000,
          manifestLoadingMaxRetry: 1,
          levelLoadingMaxRetry: 1,
          fragLoadingTimeOut: 20_000,
        });
        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!alive || hlsRef.current !== hls) return;
          void requestPlay();
          armStallWatchdog();
        });

        hls.on(Hls.Events.FRAG_LOADED, () => {
          if (!alive || hlsRef.current !== hls) return;
          gotFrame = true;
          if (video.readyState >= 2) markFrameAvailable();
          else armStallWatchdog();
        });

        hls.on(Hls.Events.ERROR, (_event: unknown, data: any) => {
          if (!alive || hlsRef.current !== hls || !data || !data.fatal) return;

          if (isPermanentStreamStatus(data)) {
            // Upstream bilang kamera tidak ada. Mengulang hanya menambah error.
            destroyHls();
            setPhase('error');
            onError(`Stream ${label} sedang tidak tersedia di sumber CCTV.`);
            return;
          }

          if (data.type === 'mediaError') {
            try {
              hls.recoverMediaError();
              return;
            } catch {
              /* jatuh ke restart/fallback di bawah */
            }
          }

          destroyHls();
          if (fallbackUrl) usingFallback = !usingFallback;
          scheduleRestart(data.type === 'networkError' ? 1200 : 1500);
        });

        hls.loadSource(sourceUrl);
        hls.attachMedia(video);
        armStallWatchdog();
      };

      video.addEventListener('loadeddata', handleLoadedData);
      video.addEventListener('playing', handlePlaying);
      video.addEventListener('pause', handlePause);
      video.addEventListener('error', handleVideoError);
      void start(null);

      return () => {
        alive = false;
        clearStall();
        clearRestart();
        destroyHls();
        video.removeEventListener('loadeddata', handleLoadedData);
        video.removeEventListener('playing', handlePlaying);
        video.removeEventListener('pause', handlePause);
        video.removeEventListener('error', handleVideoError);
        video.pause();
        video.removeAttribute('src');
        video.load();
        if (requestPlayRef.current === requestPlay) {
          requestPlayRef.current = async () => {};
        }
      };
      // Parent memakai callback inline; restart hanya berubah saat URL/reloadKey berubah.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, fallbackUrl, preferFallbackOnMse, reloadKey]);

    useEffect(() => {
      return () => {
        phaseRef.current = 'connecting';
      };
    }, []);

    return (
      <div className="hls-wrap">
        <video
          ref={videoRef}
          className="hls-video"
          muted
          autoPlay
          playsInline
          preload="auto"
          controls={false}
          aria-label={`Live stream ${label}`}
          onClick={togglePlayback}
        />
        {needsPlay && (
          <button
            type="button"
            className="player-play-overlay"
            onClick={(event) => {
              event.stopPropagation();
              void requestPlay();
            }}
            aria-label={`Putar live stream ${label}`}
          >
            <span className="player-play-icon"><Play size={28} fill="currentColor" /></span>
            <span>Putar video</span>
          </button>
        )}
      </div>
    );
  }
);

HlsPlayer.displayName = 'HlsPlayer';

export default HlsPlayer;
