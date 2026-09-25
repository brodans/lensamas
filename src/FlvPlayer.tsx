import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import type { PlayerPhase } from './types';

export interface FlvPlayerHandle {
  getVideo(): HTMLVideoElement | null;
}

interface FlvPlayerProps {
  url: string;
  label?: string;
  reloadKey?: number;
  onPhase: (phase: PlayerPhase) => void;
  onError: (message: string) => void;
}

type MpegtsApi = typeof import('mpegts.js').default;
type MpegtsPlayer = ReturnType<MpegtsApi['createPlayer']>;
let mpegtsLoader: Promise<MpegtsApi> | null = null;

function loadMpegts(): Promise<MpegtsApi> {
  if (!mpegtsLoader) {
    mpegtsLoader = import('mpegts.js')
      .then((module) => module.default)
      .catch((error) => {
        mpegtsLoader = null;
        throw error;
      });
  }
  return mpegtsLoader;
}

const MAX_RESTARTS = 5;
const STALL_TIMEOUT_MS = 15_000;

/**
 * Server Mojokerto mengirim satu text frame kosong sebagai kontrol sebelum FLV
 * binary. mpegts.js perceives text as fatal, jadi filter hanya diterapkan
 * selama player FLV aktif dan seluruh frame media tetap diteruskan apa adanya.
 */
function installTextControlFrameFilter(): () => void {
  const NativeWebSocket = window.WebSocket;

  const FilteringWebSocket = function (
    url: string | URL,
    protocols?: string | string[]
  ): WebSocket {
    const socket = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols);
    const endpoint = typeof url === 'string' ? url : url.href;
    if (!/^wss?:\/\//i.test(endpoint)) {
      return socket;
    }
    let currentHandler: ((event: MessageEvent<unknown>) => unknown) | null = null;

    Object.defineProperty(socket, 'onmessage', {
      configurable: true,
      enumerable: true,
      get: () => currentHandler,
      set: (handler: ((event: MessageEvent<unknown>) => unknown) | null) => {
        currentHandler = handler;
        socket.addEventListener('message', (event) => {
          if (typeof event.data === 'string') return;
          handler?.call(socket, event as MessageEvent<unknown>);
        });
      },
    });
    return socket;
  } as unknown as typeof WebSocket;

  FilteringWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(FilteringWebSocket, NativeWebSocket);
  window.WebSocket = FilteringWebSocket;

  return () => {
    if (window.WebSocket === FilteringWebSocket) window.WebSocket = NativeWebSocket;
  };
}

/** Player FLV-over-WebSocket untuk stream resmi Dishub Kabupaten Mojokerto. */
const FlvPlayer = forwardRef<FlvPlayerHandle, FlvPlayerProps>(
  ({ url, label = 'CCTV', reloadKey = 0, onPhase, onError }, ref) => {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const playerRef = useRef<MpegtsPlayer | null>(null);
    const phaseRef = useRef<PlayerPhase>('connecting');
    const requestPlayRef = useRef<() => Promise<void>>(async () => {});
    const [needsPlay, setNeedsPlay] = useState(false);

    const requestPlay = useCallback(async (): Promise<void> => {
      await requestPlayRef.current();
    }, []);

    const setPhase = useCallback((phase: PlayerPhase): void => {
      if (phaseRef.current === phase) return;
      phaseRef.current = phase;
      onPhase(phase);
    }, [onPhase]);

    useImperativeHandle(ref, () => ({ getVideo: () => videoRef.current }));

    useEffect(() => {
      const video = videoRef.current;
      if (!video || !url) return undefined;

      let alive = true;
      let attempts = 0;
      let gotFrame = false;
      let restartTimer: number | null = null;
      let stallTimer: number | null = null;
      let lastProgressTime = 0;
      let mpegtsApi: MpegtsApi | null = null;
      const restoreWebSocket = installTextControlFrameFilter();

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
            player.pause();
          } catch {
            /* noop */
          }
          try {
            player.unload();
          } catch {
            /* noop */
          }
          try {
            player.detachMediaElement();
          } catch {
            /* noop */
          }
          try {
            player.destroy();
          } catch {
            /* noop */
          }
        }
      };

      const armWatchdog = (): void => {
        if (stallTimer !== null) window.clearTimeout(stallTimer);
        lastProgressTime = video.currentTime;
        stallTimer = window.setTimeout(() => {
          if (!alive) return;
          if (video.paused) {
            setNeedsPlay(true);
            armWatchdog();
            return;
          }
          if (gotFrame && video.readyState >= 2 && video.currentTime > lastProgressTime + 0.25) {
            armWatchdog();
            return;
          }
          destroyPlayer();
          scheduleRestart(1500);
        }, STALL_TIMEOUT_MS);
      };

      const playVideo = async (): Promise<void> => {
        if (!alive) return;
        try {
          await video.play();
          if (!alive) return;
          setNeedsPlay(false);
          setPhase(video.readyState >= 2 && video.videoWidth > 0 ? 'live' : 'connecting');
          armWatchdog();
        } catch {
          if (!alive) return;
          setNeedsPlay(true);
          setPhase('connecting');
        }
      };
      requestPlayRef.current = playVideo;

      const scheduleRestart = (delay: number): void => {
        if (!alive || restartTimer !== null) return;
        attempts += 1;
        if (attempts > MAX_RESTARTS) {
          setPhase('error');
          onError(`Stream ${label} belum tersedia. Periksa koneksi lalu coba kembali.`);
          return;
        }
        setPhase('connecting');
        restartTimer = window.setTimeout(() => {
          restartTimer = null;
          destroyPlayer();
          void start();
        }, delay);
      };

      const handlePlaying = (): void => {
        if (!alive) return;
        gotFrame = true;
        attempts = 0;
        setNeedsPlay(false);
        setPhase('live');
        armWatchdog();
      };
      const handlePause = (): void => {
        if (alive && !video.ended) setNeedsPlay(true);
      };
      const handleMediaError = (): void => {
        if (!alive) return;
        destroyPlayer();
        scheduleRestart(1000);
      };

      const start = async (): Promise<void> => {
        if (!alive) return;
        setPhase('connecting');
        gotFrame = false;

        try {
          mpegtsApi ||= await loadMpegts();
          if (!alive || !mpegtsApi) return;
          if (!mpegtsApi.isSupported() || typeof window.WebSocket === 'undefined') {
            setPhase('error');
            onError('Peramban ini tidak mendukung pemutaran FLV live. Gunakan Chrome/Edge/Safari versi terbaru.');
            return;
          }

          const player = mpegtsApi.createPlayer({
            type: 'flv',
            isLive: true,
            hasAudio: false,
            hasVideo: true,
            url,
          }, {
            enableWorker: false,
            enableStashBuffer: false,
            lazyLoad: false,
            deferLoadAfterSourceOpen: false,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 2,
            liveBufferLatencyMinRemain: 0.4,
          });
          player.attachMediaElement(video);
          playerRef.current = player;
          player.on(mpegtsApi.Events.ERROR, () => {
            if (!alive || playerRef.current !== player) return;
            destroyPlayer();
            scheduleRestart(1200);
          });
          player.on(mpegtsApi.Events.LOADING_COMPLETE, () => {
            if (!alive || playerRef.current !== player) return;
            destroyPlayer();
            scheduleRestart(800);
          });
          player.load();
          void playVideo();
          armWatchdog();
        } catch (error) {
          if (!alive) return;
          destroyPlayer();
          scheduleRestart(1500);
          if (attempts > MAX_RESTARTS) onError((error as Error).message);
        }
      };

      video.addEventListener('playing', handlePlaying);
      video.addEventListener('pause', handlePause);
      video.addEventListener('error', handleMediaError);
      void start();

      return () => {
        alive = false;
        clearTimers();
        destroyPlayer();
        restoreWebSocket();
        video.removeEventListener('playing', handlePlaying);
        video.removeEventListener('pause', handlePause);
        video.removeEventListener('error', handleMediaError);
        video.pause();
        video.removeAttribute('src');
        video.load();
        if (requestPlayRef.current === playVideo) requestPlayRef.current = async () => {};
      };
      // Callback parent dibuat inline; koneksi hanya diulang saat URL/reloadKey berubah.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, reloadKey]);

    return (
      <div className="hls-wrap flv-wrap">
        <video
          ref={videoRef}
          className="hls-video"
          muted
          autoPlay
          playsInline
          preload="auto"
          controls={false}
          aria-label={`Live stream ${label}`}
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            if (video.paused) void requestPlay();
            else video.pause();
          }}
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

FlvPlayer.displayName = 'FlvPlayer';

export default FlvPlayer;
