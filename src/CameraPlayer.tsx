import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Camera as CameraIcon,
  CircleDot,
  Square,
  Radio,
  Loader2,
  AlertCircle,
  MapPin,
  RotateCcw,
  Cctv,
  X,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { VideoRTC } from './vendor/video-rtc.js';
import JsmpegPlayer, { type JsmpegPlayerHandle } from './JsmpegPlayer';
import HlsPlayer, { type HlsPlayerHandle } from './HlsPlayer';
import FlvPlayer, { type FlvPlayerHandle } from './FlvPlayer';
import MjpegPlayer, { type MjpegPlayerHandle } from './MjpegPlayer';
import type {
  Camera,
  PlayerPhase,
  VideoRTCElement,
  HTMLVideoElementWithCaptureStream,
} from './types';

function ensureVideoRTCElement(): void {
  if (typeof window !== 'undefined' && !customElements.get('video-rtc')) {
    customElements.define('video-rtc', class extends VideoRTC {});
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface CameraPlayerProps {
  camera: Camera;
  streamUrl: string | null;
  isLoadingUrl?: boolean;
  streamError?: string;
  onRefreshUrl: (slug: string) => Promise<unknown>;
  onClose: () => void;
  onRetry?: () => void;
}

const CameraPlayer: React.FC<CameraPlayerProps> = ({
  camera,
  streamUrl,
  isLoadingUrl = false,
  streamError = '',
  onRefreshUrl,
  onClose,
  onRetry,
}) => {
  const playerBodyRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<VideoRTCElement | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const recTimerRef = useRef<number | null>(null);

  const [phase, setPhase] = useState<PlayerPhase>('loading');
  const [error, setError] = useState<string>('');
  const [mode, setMode] = useState<string>('');
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [isReloading, setIsReloading] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [jsmpegReloadKey, setJsmpegReloadKey] = useState<number>(0);
  const jsmpegRef = useRef<JsmpegPlayerHandle | null>(null);
  const isJsmpeg = camera.protocol === 'jsmpeg';
  const [hlsReloadKey, setHlsReloadKey] = useState<number>(0);
  const hlsRef = useRef<HlsPlayerHandle | null>(null);
  const isHls = camera.protocol === 'hls';
  const [flvReloadKey, setFlvReloadKey] = useState<number>(0);
  const flvRef = useRef<FlvPlayerHandle | null>(null);
  const isFlv = camera.protocol === 'flv';
  const [mjpegReloadKey, setMjpegReloadKey] = useState<number>(0);
  const mjpegRef = useRef<MjpegPlayerHandle | null>(null);
  const isMjpeg = camera.protocol === 'mjpeg';
  const streamLabel =
    camera.source === 'madiun' ? 'CCTV Madiun' :
    camera.source === 'magetan' ? 'CCTV Magetan' :
    camera.source === 'trenggalek' ? 'CCTV Trenggalek' :
    camera.source === 'kediri' ? 'CCTV Kediri' :
    camera.source === 'tulungagung' ? 'CCTV Tulungagung' :
    camera.source === 'malang' ? 'CCTV Malang' :
    camera.source === 'mojokerto' ? 'CCTV Mojokerto' :
    camera.source === 'surabaya' ? 'CCTV Surabaya' :
    camera.source === 'bojonegoro' ? 'CCTV Bojonegoro' :
    camera.source === 'gresik' ? 'CCTV Gresik' :
    camera.source === 'tuban' ? 'CCTV Tuban' :
    camera.source === 'banyuwangi' ? 'CCTV Banyuwangi' :
    camera.source === 'bondowoso' ? 'CCTV Bondowoso' :
    camera.source === 'situbondo' ? 'CCTV Situbondo' :
    camera.source === 'pasuruan' ? 'CCTV Pasuruan' :
    'CCTV';

  useEffect(() => {
    const syncFullscreenState = (): void => {
      setIsFullscreen(document.fullscreenElement === playerBodyRef.current);
    };

    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  const toggleFullscreen = useCallback(async (): Promise<void> => {
    const playerBody = playerBodyRef.current;
    if (!playerBody) return;

    try {
      if (document.fullscreenElement === playerBody) {
        await document.exitFullscreen();
      } else {
        await playerBody.requestFullscreen();
      }
    } catch {
      setError('Mode fullscreen tidak tersedia pada browser ini.');
    }
  }, []);

  const stopRecording = useCallback((updateState = true): void => {
    if (recRef.current && recRef.current.state !== 'inactive') {
      recRef.current.stop();
    }
    recRef.current = null;
    if (updateState) setIsRecording(false);
    if (recTimerRef.current !== null) {
      window.clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopRecording(false);
  }, [stopRecording]);

  // Mount player + sambungkan ke stream WebSocket go2rtc
  useEffect(() => {
    if (streamError) {
      setPhase('error');
      setError(streamError);
      return;
    }

    if (isMjpeg && camera.streamConfigured === false) {
      setPhase('error');
      setError(
        camera.source === 'bondowoso'
          ? 'Stream Bondowoso belum dikonfigurasi di server Vercel.'
          : 'Stream MJPEG Situbondo belum dikonfigurasi di server Vercel.'
      );
      return;
    }

    if (isLoadingUrl || !streamUrl) {
      setPhase('connecting');
      setError('');
      return;
    }

    if (isJsmpeg) {
      setPhase('connecting');
      setError('');
      return;
    }

    if (isHls) {
      setPhase('connecting');
      setError('');
      return;
    }

    if (isFlv) {
      setPhase('connecting');
      setError('');
      return;
    }

    if (isMjpeg) {
      setPhase('connecting');
      setError('');
      return;
    }

    let cancelled = false;
    let pollInterval: number | null = null;

    ensureVideoRTCElement();
    if (cancelled || !containerRef.current) return;

    const el = document.createElement('video-rtc') as unknown as VideoRTCElement;
    const supportsMse = 'MediaSource' in window || 'ManagedMediaSource' in window;
    el.mode = supportsMse ? 'webrtc,mse,mjpeg' : 'webrtc,mjpeg';
    el.media = 'video,audio';
    containerRef.current.innerHTML = '';
    containerRef.current.appendChild(el);

    if (el.video) {
      el.video.muted = true;
      el.video.autoplay = true;
      el.video.playsInline = true;
    }
    el.src = streamUrl;

    playerRef.current = el;
    setPhase('connecting');
    setError('');

    const handleFrame = (event: Event): void => {
      const detail = (event as CustomEvent<{ mode?: string }>).detail;
      if (detail?.mode) setMode(detail.mode.toUpperCase());
      if (detail?.mode === 'mse' && (!el.video || el.video.videoWidth <= 0)) return;
      setError('');
      setPhase('live');
    };
    const handleVideoFrame = (): void => {
      if (!el.video || el.video.videoWidth <= 0) return;
      setError('');
      setPhase('live');
    };
    el.addEventListener('videortc-frame', handleFrame);
    el.video?.addEventListener('loadeddata', handleVideoFrame);
    el.video?.addEventListener('playing', handleVideoFrame);

    // Status WebSocket alone tidak cukup: Chrome lama menampilkan "LIVE"
    // although the chosen codec has not produced a decodable frame.
    pollInterval = window.setInterval(() => {
      if (el.pcState === WebSocket.OPEN) {
        setMode('WEBRTC');
        if (el.video && el.video.videoWidth > 0 && el.video.readyState >= 2) {
          setPhase('live');
        }
      } else if (el.wsState === WebSocket.OPEN) {
        if (el.video && el.video.videoWidth > 0 && el.video.readyState >= 2) {
          setPhase('live');
        }
      } else if (el.wsState === WebSocket.CLOSED) {
        setPhase('error');
        setError('Koneksi stream terputus atau codec tidak didukung perangkat.');
      }
    }, 300);

    return () => {
      cancelled = true;
      if (pollInterval !== null) window.clearInterval(pollInterval);
      stopRecording(false);

      const activePlayer = playerRef.current;
      if (activePlayer) {
        activePlayer.removeEventListener('videortc-frame', handleFrame);
        activePlayer.video?.removeEventListener('loadeddata', handleVideoFrame);
        activePlayer.video?.removeEventListener('playing', handleVideoFrame);
        try {
          activePlayer.ondisconnect();
        } catch {
          // Cleanup internal
        }
        activePlayer.remove();
      }
      playerRef.current = null;
      if (containerRef.current) {
        containerRef.current.replaceChildren();
      }
    };
  }, [camera.source, camera.streamConfigured, streamUrl, isLoadingUrl, streamError, stopRecording, isJsmpeg, isHls, isFlv, isMjpeg]);

  // Auto-refresh signed URL sebelum kedaluwarsa (~5 menit)
  useEffect(() => {
    if (!camera?.expiresAt) return;
    const remainingMs = camera.expiresAt.getTime() - Date.now();
    const delay = Math.max(5000, remainingMs - 30000);

    const timer = window.setTimeout(() => {
      onRefreshUrl(camera.slug).catch(() => {});
    }, delay);

    return () => window.clearTimeout(timer);
  }, [camera, onRefreshUrl]);

  // Snapshot PNG (mendukung stream go2rtc berbasis <video> maupun kanvas JSMpeg)
  const takeSnapshot = useCallback(() => {
    if (isMjpeg) {
      const image = mjpegRef.current?.getImage();
      if (!image || !image.complete || image.naturalWidth <= 0) return;
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `lensamas-snapshot-${camera.slug}-${Date.now()}.png`);
      }, 'image/png');
      return;
    }

    if (isJsmpeg) {
      const source = jsmpegRef.current?.getCanvas();
      if (!source) return;

      const canvas = document.createElement('canvas');
      canvas.width = source.width || 960;
      canvas.height = source.height || 540;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) {
          downloadBlob(blob, `lensamas-snapshot-${camera.slug}-${Date.now()}.png`);
        }
      }, 'image/png');
      return;
    }

    const video = isHls
      ? hlsRef.current?.getVideo()
      : isFlv
        ? flvRef.current?.getVideo()
        : playerRef.current?.video;
    if (!video || video.readyState < 2) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) {
        downloadBlob(blob, `lensamas-snapshot-${camera.slug}-${Date.now()}.png`);
      }
    }, 'image/png');
  }, [camera.slug, isJsmpeg, isHls, isFlv, isMjpeg]);

  // Rekam WebM
  const startRecording = useCallback(() => {
    let stream: MediaStream | undefined;

    if (isMjpeg) {
      setError('Pereaman video MJPEG belum tersedia; gunakan snapshot untuk mengambil frame.');
      return;
    }

    if (isJsmpeg) {
      stream = jsmpegRef.current?.getCanvas()?.captureStream?.(30);
    } else {
      const video = (isHls
        ? hlsRef.current?.getVideo()
        : isFlv
          ? flvRef.current?.getVideo()
          : playerRef.current?.video) as HTMLVideoElementWithCaptureStream | undefined;
      if (!video || video.readyState < 2 || video.videoWidth <= 0) return;
      stream = video.captureStream?.(30);
    }

    if (!stream) {
      setError('Browser tidak mendukung perekaman langsung dari stream video.');
      return;
    }

    const preferredMimes = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const supportedMime = preferredMimes.find((m) =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)
    );

    try {
      const recorder = new MediaRecorder(
        stream,
        supportedMime ? { mimeType: supportedMime, videoBitsPerSecond: 2_500_000 } : undefined
      );

      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      recorder.onstop = () => {
        const mimeType = recorder.mimeType || 'video/webm';
        const blob = new Blob(chunks, { type: mimeType });
        const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
        downloadBlob(blob, `lensamas-rekaman-${camera.slug}-${Date.now()}.${extension}`);
      };

      recorder.start(1000);
      recRef.current = recorder;
      setIsRecording(true);
      setRecordingSeconds(0);

      recTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      setError(`Gagal memulai perekaman: ${(err as Error).message}`);
    }
  }, [camera.slug, isJsmpeg, isHls, isFlv, isMjpeg]);

  const handleManualReload = useCallback(async () => {
    stopRecording();
    if (isJsmpeg) {
      setJsmpegReloadKey((key) => key + 1);
      return;
    }
    if (isHls) {
      setHlsReloadKey((key) => key + 1);
      return;
    }
    if (isFlv) {
      setFlvReloadKey((key) => key + 1);
      return;
    }
    if (isMjpeg) {
      setMjpegReloadKey((key) => key + 1);
      return;
    }
    setIsReloading(true);
    try {
      await onRefreshUrl(camera.slug);
    } finally {
      setIsReloading(false);
    }
  }, [camera.slug, onRefreshUrl, stopRecording, isJsmpeg, isHls, isFlv, isMjpeg]);

  useEffect(() => {
    if (isJsmpeg) setMode('JSMPEG');
    else if (isHls) setMode('HLS');
    else if (isFlv) setMode('FLV');
    else if (isMjpeg) setMode('MJPEG');
  }, [isJsmpeg, isHls, isFlv, isMjpeg]);

  return (
    <div className="player">
      {/* Header Player Rapi: Judul Kiri, Semua Tombol Sejajar di Kanan */}
      <div className="player-head">
        <div className="player-title-block">
          <div className="player-channel-pill">
            <Cctv size={14} />
            <span>{camera.channel ? `CH ${camera.channel}` : 'CCTV'}</span>
          </div>
          <div className="player-title-info">
            <h3 className="player-title">{camera.name}</h3>
            <div className="player-location">
              <MapPin size={12} className="loc-icon" />
              <span>{camera.location}</span>
            </div>
          </div>
        </div>

        {/* Action Controls & Tombol Close Sejajar */}
        <div className="player-actions">
          <div className={`status-indicator-pill ${phase}`}>
            {phase === 'live' && <Radio size={13} className="live-pulse" />}
            {phase === 'connecting' && <Loader2 size={13} className="animate-spin" />}
            {phase === 'error' && <AlertCircle size={13} />}
            <span>
              {phase === 'live' ? 'LIVE' : phase === 'connecting' ? 'CONNECTING' : 'OFFLINE'}
              {mode ? ` · ${mode}` : ''}
            </span>
          </div>

          <div className="btn-group">
            <button
              type="button"
              className="player-btn"
              onClick={takeSnapshot}
              disabled={phase !== 'live'}
              title="Ambil Foto Snapshot (PNG)"
            >
              <CameraIcon size={14} />
              <span className="btn-label">Snapshot</span>
            </button>

            {isRecording ? (
              <button
                type="button"
                className="player-btn btn-danger"
                onClick={() => stopRecording()}
                title="Hentikan Perekaman"
              >
                <Square size={13} />
                <span>Stop ({formatDuration(recordingSeconds)})</span>
              </button>
            ) : (
              <button
                type="button"
                className="player-btn"
                onClick={startRecording}
                disabled={phase !== 'live' || isMjpeg}
                title={isMjpeg ? 'Rekaman MJPEG belum tersedia' : 'Mulai Rekam Video (WebM)'}
              >
                <CircleDot size={14} className="text-rose" />
                <span className="btn-label">Rekam</span>
              </button>
            )}

            <button
              type="button"
              className="player-btn btn-icon-only"
              onClick={() => void handleManualReload()}
              title="Segarkan Koneksi Stream"
            >
              <RotateCcw size={14} className={isReloading ? 'is-spinning' : ''} />
            </button>

            <button
              type="button"
              className="player-btn btn-icon-only"
              onClick={() => void toggleFullscreen()}
              title={isFullscreen ? 'Keluar dari fullscreen' : 'Buka fullscreen'}
              aria-label={isFullscreen ? 'Keluar dari fullscreen' : 'Buka fullscreen'}
              aria-pressed={isFullscreen}
            >
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>

            {/* Tombol X Tutup Sejajar Rapi di Ujung Kanan */}
            <button
              type="button"
              className="player-btn btn-icon-only btn-close-x"
              onClick={onClose}
              title="Tutup Pemutar (Esc)"
              aria-label="Tutup pemutar"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Video Stream Frame 16:9 yang Presisi Sejak Awal */}
      {isJsmpeg ? (
        <div className="player-body player-body-jsmpeg" ref={playerBodyRef}>
          <JsmpegPlayer
            ref={jsmpegRef}
            url={camera.streamUrl || streamUrl || ''}
            reloadKey={jsmpegReloadKey}
            onPhase={(nextPhase) => {
              if (nextPhase === 'connecting') setError('');
              setPhase(nextPhase);
            }}
            onError={(message) => {
              setError(message);
            }}
          />
        </div>
      ) : isMjpeg ? (
        <div className="player-body player-body-mjpeg" ref={playerBodyRef}>
          <MjpegPlayer
            ref={mjpegRef}
            url={camera.streamUrl || streamUrl || ''}
            label={streamLabel}
            reloadKey={mjpegReloadKey}
            disabled={camera.streamConfigured === false}
            onPhase={(nextPhase) => {
              if (nextPhase === 'connecting') setError('');
              setPhase(nextPhase);
            }}
            onError={(message) => {
              setError(message);
            }}
          />
        </div>
      ) : isHls ? (
        <div className="player-body player-body-hls" ref={playerBodyRef}>
          <HlsPlayer
            ref={hlsRef}
            url={camera.streamUrl || streamUrl || ''}
            fallbackUrl={camera.fallbackStreamUrl}
            preferFallbackOnMse={camera.source === 'tulungagung' || camera.source === 'malang'}
            label={streamLabel}
            reloadKey={hlsReloadKey}
            onPhase={(nextPhase) => {
              if (nextPhase === 'connecting') setError('');
              setPhase(nextPhase);
            }}
            onError={(message) => {
              setError(message);
            }}
          />
        </div>
      ) : isFlv ? (
        <div className="player-body player-body-flv" ref={playerBodyRef}>
          <FlvPlayer
            ref={flvRef}
            url={camera.streamUrl || streamUrl || ''}
            label={streamLabel}
            reloadKey={flvReloadKey}
            onPhase={(nextPhase) => {
              if (nextPhase === 'connecting') setError('');
              setPhase(nextPhase);
            }}
            onError={(message) => {
              setError(message);
            }}
          />
        </div>
      ) : (
        <div
          className="player-body"
          ref={(element) => {
            playerBodyRef.current = element;
            containerRef.current = element;
          }}
        />
      )}

      {error && (
        <div className="player-error">
          <AlertCircle size={15} />
          <span>{error}</span>
          {onRetry && (
            <button
              type="button"
              className="player-btn btn-retry-in-frame"
              onClick={onRetry}
              style={{ marginLeft: 'auto' }}
            >
              <RotateCcw size={13} />
              <span>Coba Hubungkan Ulang</span>
            </button>
          )}
        </div>
      )}

    </div>
  );
};

export default CameraPlayer;
