import React, { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Cctv,
  Video,
  VideoOff,
  Wifi,
  Search,
  X,
  MapPin,
  Loader2,
  RotateCcw,
  Layers,
  ChevronRight,
  ChevronDown,
  ShieldCheck,
  Sun,
  Moon,
  WifiOff,
  CloudOff,
} from 'lucide-react';
import MapView from './MapView';
import CameraPlayer from './CameraPlayer';
import {
  fetchCameras,
  fetchMadiunCameras,
  fetchMagetanCameras,
  fetchTrenggalekCameras,
  fetchKediriCameras,
  fetchTulungagungCameras,
  fetchMalangCameras,
  fetchMojokertoCameras,
  fetchSurabayaCameras,
  fetchBojonegoroCameras,
  fetchGresikCameras,
  fetchTubanCameras,
  fetchBanyuwangiCameras,
  fetchBondowosoCameras,
  fetchSitubondoCameras,
  fetchPasuruanCameras,
  startSurabayaStream,
  stopSurabayaStream,
  startGresikStream,
  heartbeatGresikStream,
  stopGresikStream,
  fetchWifiPoints,
  fetchStreamUrl,
  getCachedCameras,
  getCachedWifi,
  getLastSyncTime,
  saveOfflineData,
  formatApiErrorMessage,
} from './api';
import type { Camera, CameraSource, StreamInfo, WifiPoint } from './types';

type TabFilter = 'all' | 'cctv' | 'wifi';
type StatusFilter = 'all' | 'active' | 'inactive';
type ThemeMode = 'dark' | 'light';
type SourceFilter = CameraSource | 'all';

/** Normalisasi sumber kamera: data lama tanpa `source` dianggap Ponorogo. */
function cameraSource(camera: Camera): CameraSource {
  if (camera.source === 'madiun') return 'madiun';
  if (camera.source === 'magetan') return 'magetan';
  if (camera.source === 'trenggalek') return 'trenggalek';
  if (camera.source === 'kediri') return 'kediri';
  if (camera.source === 'tulungagung') return 'tulungagung';
  if (camera.source === 'malang') return 'malang';
  if (camera.source === 'mojokerto') return 'mojokerto';
  if (camera.source === 'surabaya') return 'surabaya';
  if (camera.source === 'bojonegoro') return 'bojonegoro';
  if (camera.source === 'gresik') return 'gresik';
  if (camera.source === 'tuban') return 'tuban';
  if (camera.source === 'banyuwangi') return 'banyuwangi';
  if (camera.source === 'bondowoso') return 'bondowoso';
  if (camera.source === 'situbondo') return 'situbondo';
  if (camera.source === 'pasuruan') return 'pasuruan';
  return 'ponorogo';
}

/** Label tampilan ringkas untuk tiap sumber kamera. */
function sourceLabel(source: CameraSource): string {
  if (source === 'madiun') return 'Madiun';
  if (source === 'magetan') return 'Magetan';
  if (source === 'trenggalek') return 'Trenggalek';
  if (source === 'kediri') return 'Kediri';
  if (source === 'tulungagung') return 'Tulungagung';
  if (source === 'malang') return 'Malang';
  if (source === 'mojokerto') return 'Mojokerto';
  if (source === 'surabaya') return 'Surabaya';
  if (source === 'bojonegoro') return 'Bojonegoro';
  if (source === 'gresik') return 'Gresik';
  if (source === 'tuban') return 'Tuban';
  if (source === 'banyuwangi') return 'Banyuwangi';
  if (source === 'bondowoso') return 'Bondowoso';
  if (source === 'situbondo') return 'Situbondo';
  if (source === 'pasuruan') return 'Pasuruan';
  return 'Ponorogo';
}

const SOURCE_OPTIONS: Array<{ id: CameraSource; title: string }> = [
  { id: 'ponorogo', title: 'CCTV Kabupaten Ponorogo' },
  { id: 'madiun', title: 'CCTV Kota Madiun (primary IP, Villabs fallback)' },
  { id: 'magetan', title: 'CCTV Kabupaten Magetan (Sarangan Vision)' },
  { id: 'trenggalek', title: 'CCTV Kabupaten Trenggalek (GEOTIK)' },
  { id: 'kediri', title: 'CCTV Kota Kediri (ATCS)' },
  { id: 'tulungagung', title: 'CCTV Kabupaten Tulungagung' },
  { id: 'malang', title: 'CCTV Kota Malang' },
  { id: 'mojokerto', title: 'CCTV Kabupaten Mojokerto' },
  { id: 'surabaya', title: 'CCTV Kota Surabaya' },
  { id: 'bojonegoro', title: 'CCTV Kabupaten Bojonegoro' },
  { id: 'gresik', title: 'CCTV Kabupaten Gresik' },
  { id: 'tuban', title: 'CCTV Kabupaten Tuban' },
  { id: 'banyuwangi', title: 'CCTV Kabupaten Banyuwangi' },
  { id: 'bondowoso', title: 'CCTV Kabupaten Bondowoso' },
  { id: 'situbondo', title: 'CCTV Kabupaten Situbondo' },
  { id: 'pasuruan', title: 'CCTV Kabupaten Pasuruan' },
];

function canPlayCamera(camera: Camera): boolean {
  return camera.status === 'online' || (camera.status === 'unknown' && Boolean(camera.streamUrl));
}

function isWifiActive(status?: string): boolean {
  if (!status) return true;
  return !['offline', 'inactive', 'nonaktif', 'disconnected', 'down', 'false', '0'].includes(
    status.trim().toLowerCase()
  );
}

function formatSyncTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

const App: React.FC = () => {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('lensamas_theme') as ThemeMode;
      if (saved === 'dark' || saved === 'light') return saved;
    }
    return 'dark';
  });

  // Inisialisasi awal dengan data cache offline agar UI langsung tampil cepat (0ms)
  const [cameras, setCameras] = useState<Camera[]>(() => getCachedCameras());
  const [wifiPoints, setWifiPoints] = useState<WifiPoint[]>(() => getCachedWifi());
  const [isUsingCache, setIsUsingCache] = useState<boolean>(() => getCachedCameras().length > 0);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(() => getLastSyncTime());
  const [isOffline, setIsOffline] = useState<boolean>(() => (typeof navigator !== 'undefined' ? !navigator.onLine : false));

  const [loading, setLoading] = useState<boolean>(() => getCachedCameras().length === 0);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [activeTab, setActiveTab] = useState<TabFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [isSourceFilterOpen, setIsSourceFilterOpen] = useState<boolean>(false);
  const [mapFocus, setMapFocus] = useState<{ latitude: number; longitude: number; zoom: number; key: number } | null>(null);
  const [cameraStatusFilter, setCameraStatusFilter] = useState<StatusFilter>('all');
  const [wifiStatusFilter, setWifiStatusFilter] = useState<StatusFilter>('all');
  const [isLegalOpen, setIsLegalOpen] = useState<boolean>(false);

  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [selectedCameraSlug, setSelectedCameraSlug] = useState<string | null>(null);
  const [selectedWifiId, setSelectedWifiId] = useState<number | null>(null);
  const [wifiFocusKey, setWifiFocusKey] = useState<number>(0);
  const [focusedLocation, setFocusedLocation] = useState<{ latitude: number; longitude: number } | null>(null);

  const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);
  const [streamBusy, setStreamBusy] = useState<boolean>(false);
  const [streamError, setStreamError] = useState<string>('');

  const refreshKeyRef = useRef<number>(0);
  const loadInFlightRef = useRef<Promise<void> | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const activeSurabayaIdRef = useRef<string | null>(null);
  const activeGresikRef = useRef<{ cameraId: string; viewerId: string } | null>(null);
  const gresikHeartbeatTimerRef = useRef<number | null>(null);

  const stopActiveGresik = useCallback((): void => {
    if (gresikHeartbeatTimerRef.current !== null) {
      window.clearInterval(gresikHeartbeatTimerRef.current);
      gresikHeartbeatTimerRef.current = null;
    }
    const active = activeGresikRef.current;
    if (active) {
      stopGresikStream(active.cameraId, active.viewerId);
      activeGresikRef.current = null;
    }
  }, []);

  useEffect(() => {
    const handlePageHide = (): void => {
      loadAbortRef.current?.abort();
      stopActiveGresik();
      if (activeSurabayaIdRef.current) {
        stopSurabayaStream(activeSurabayaIdRef.current);
        activeSurabayaIdRef.current = null;
      }
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      handlePageHide();
    };
  }, [stopActiveGresik]);

  // Terapkan tema ke document root & simpan ke localStorage
  useEffect(() => {
    return () => loadAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('lensamas_theme', theme);
  }, [theme]);

  const toggleTheme = useCallback((): void => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  // Muat daftar kamera & WiFi dari API dengan ketahanan offline. Data primer
  // tampil lebih dulu; sumber regional yang lebih banyak dimuat setelahnya agar
  // peta tidak menunggu semua upstream sekaligus.
  const loadData = useCallback((isManualRefresh = false): Promise<void> => {
    if (loadInFlightRef.current) {
      // Jangan tunggu task yang sudah dibatalkan (mis. remount StrictMode atau
      // `pagehide`); task itu tidak akan pernah mengisi state lagi.
      if (!loadAbortRef.current?.signal.aborted) return loadInFlightRef.current;
      loadInFlightRef.current = null;
    }
    if (isManualRefresh) setIsRefreshing(true);

    const task = (async (): Promise<void> => {
      const controller = new AbortController();
      loadAbortRef.current = controller;
      const signal = controller.signal;
      try {
        let primaryError: unknown = null;
        const ponorogoWithFallback = fetchCameras(signal).catch((error) => {
          primaryError = error;
          return getCachedCameras().filter((camera) => (camera.source || 'ponorogo') === 'ponorogo');
        });
        const [cams, wifi] = await Promise.all([ponorogoWithFallback, fetchWifiPoints(signal)]);
        if (controller.signal.aborted) return;
        startTransition(() => setCameras((previous) => {
          const regional = previous.filter((camera) => cameraSource(camera) !== 'ponorogo');
          return [...cams, ...regional];
        }));
        setWifiPoints(wifi);
        setLoading(false);
        setApiError(primaryError ? 'Sumber CCTV Ponorogo sedang bermasalah; sumber lain tetap dimuat.' : '');
        setIsUsingCache(Boolean(primaryError && cams.length > 0));

        const [
          madiunCams,
          magetanCams,
          trenggalekCams,
          kediriCams,
          tulungagungCams,
          malangCams,
          mojokertoCams,
          surabayaCams,
          bojonegoroCams,
          gresikCams,
          tubanCams,
          banyuwangiCams,
          bondowosoCams,
          situbondoCams,
          pasuruanCams,
        ] = await Promise.all([
          fetchMadiunCameras(signal),
          fetchMagetanCameras(signal),
          fetchTrenggalekCameras(signal),
          fetchKediriCameras(signal),
          fetchTulungagungCameras(signal),
          fetchMalangCameras(signal),
          fetchMojokertoCameras(signal),
          fetchSurabayaCameras(signal),
          fetchBojonegoroCameras(signal),
          fetchGresikCameras(signal),
          fetchTubanCameras(signal),
          fetchBanyuwangiCameras(signal),
          fetchBondowosoCameras(signal),
          fetchSitubondoCameras(signal),
          fetchPasuruanCameras(signal),
        ]);
        if (controller.signal.aborted) return;
        const mergedCams = [
          ...cams,
          ...madiunCams,
          ...magetanCams,
          ...trenggalekCams,
          ...kediriCams,
          ...tulungagungCams,
          ...malangCams,
          ...mojokertoCams,
          ...surabayaCams,
          ...bojonegoroCams,
          ...gresikCams,
          ...tubanCams,
          ...banyuwangiCams,
          ...bondowosoCams,
          ...situbondoCams,
          ...pasuruanCams,
        ];
        startTransition(() => setCameras(mergedCams));
        saveOfflineData(mergedCams, wifi);
        setLastSyncTime(new Date().toISOString());
      } catch (err) {
        if (controller.signal.aborted) return;
        const friendlyMsg = formatApiErrorMessage(err);
        setApiError(friendlyMsg);

        // Fallback ke cache jika data memori kosong.
        const cachedCams = getCachedCameras();
        if (cachedCams.length > 0) {
          startTransition(() => setCameras((prev) => {
            const merged = new Map(prev.map((camera) => [camera.slug, camera]));
            for (const camera of cachedCams) merged.set(camera.slug, camera);
            return [...merged.values()];
          }));
          setIsUsingCache(true);
        }
        const cachedWifi = getCachedWifi();
        if (cachedWifi.length > 0) {
          setWifiPoints((prev) => (prev.length === 0 ? cachedWifi : prev));
        }
      } finally {
        loadInFlightRef.current = null;
        if (loadAbortRef.current === controller) loadAbortRef.current = null;
        if (!controller.signal.aborted) {
          setLoading(false);
          if (isManualRefresh) setIsRefreshing(false);
        }
      }
    })();
    loadInFlightRef.current = task;
    return task;
  }, []);

  // Deteksi status koneksi internet perangkat secara real-time
  useEffect(() => {
    const handleOnline = (): void => {
      setIsOffline(false);
      void loadData();
    };
    const handleOffline = (): void => {
      setIsOffline(true);
      setApiError('Perangkat Anda sedang offline. Menampilkan data tersimpan.');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [loadData]);

  // Muat awal hanya satu kali. Perubahan status player tidak boleh memicu
  // refresh metadata, karena data primer sementara dapat membuat marker
  // terlihat hilang sebelum data regional selesai dimuat.
  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Polling metadata lebih hemat: cache server jauh lebih panjang daripada
  // interval ini, tab tersembunyi tidak memicu refresh, dan player aktif
  // selalu menunda request sampai player ditutup.
  useEffect(() => {
    const refreshIfVisible = (): void => {
      if (selectedCamera) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      void loadData();
    };
    const interval = window.setInterval(refreshIfVisible, 5 * 60_000);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [loadData, selectedCamera]);

  // Buka kamera dan siapkan live stream (go2rtc / JSMpeg)
  const openCamera = useCallback(async (cam: Camera): Promise<void> => {
    setSelectedCameraSlug(cam.slug);
    setSelectedCamera(cam);
    setFocusedLocation(null);
    setStreamError('');
    setStreamInfo(null);

    const key = ++refreshKeyRef.current;
    if (activeSurabayaIdRef.current) {
      stopSurabayaStream(activeSurabayaIdRef.current);
      activeSurabayaIdRef.current = null;
    }
    stopActiveGresik();

    // Sumber Madiun (primary IP, Villabs fallback) memakai URL WebSocket langsung tanpa signed URL
    if (cam.protocol === 'jsmpeg' && cam.streamUrl) {
      setStreamBusy(false);
      setStreamInfo({
        wss: cam.streamUrl,
        mode: 'jsmpeg',
        expiresAt: null,
        camera: cam,
      });
      return;
    }

    // Gresik memakai lease viewer; start dan heartbeat menjaga stream tetap hidup.
    if (cam.source === 'gresik' && cam.protocol === 'hls' && cam.sourceCode && cam.streamUrl) {
      setStreamBusy(true);
      try {
        const viewerId = await startGresikStream(cam.sourceCode);
        if (refreshKeyRef.current !== key) {
          stopGresikStream(cam.sourceCode, viewerId);
          return;
        }
        activeGresikRef.current = { cameraId: cam.sourceCode, viewerId };
        gresikHeartbeatTimerRef.current = window.setInterval(() => {
          heartbeatGresikStream(cam.sourceCode as string, viewerId);
        }, 20_000);
        setStreamInfo({
          wss: cam.streamUrl,
          mode: 'hls',
          expiresAt: null,
          camera: cam,
        });
      } catch (err) {
        if (refreshKeyRef.current === key) {
          setStreamError((err as Error).message);
        }
      } finally {
        if (refreshKeyRef.current === key) {
          setStreamBusy(false);
        }
      }
      return;
    }

    // Surabaya memerlukan start transcode upstream sebelum HLS dapat dimuat.
    if (cam.source === 'surabaya' && cam.protocol === 'hls' && cam.sourceCode && cam.streamUrl) {
      setStreamBusy(true);
      try {
        await startSurabayaStream(cam.sourceCode, cam.streamUrl);
        if (refreshKeyRef.current !== key) {
          stopSurabayaStream(cam.sourceCode);
          return;
        }
        activeSurabayaIdRef.current = cam.sourceCode;
        setStreamInfo({
          wss: cam.streamUrl,
          mode: 'hls',
          expiresAt: null,
          camera: cam,
        });
      } catch (err) {
        stopSurabayaStream(cam.sourceCode);
        activeSurabayaIdRef.current = null;
        if (refreshKeyRef.current === key) {
          setStreamError((err as Error).message);
        }
      } finally {
        if (refreshKeyRef.current === key) {
          setStreamBusy(false);
        }
      }
      return;
    }

    // HLS, FLV, dan MJPEG memiliki URL statis; stream proxy tetap server-side.
    if ((cam.protocol === 'hls' || cam.protocol === 'flv' || cam.protocol === 'mjpeg') && cam.streamUrl) {
      setStreamBusy(false);
      setStreamInfo({
        wss: cam.streamUrl,
        mode: cam.protocol,
        expiresAt: null,
        camera: cam,
      });
      return;
    }

    setStreamBusy(true);
    try {
      const info = await fetchStreamUrl(cam.slug);
      if (refreshKeyRef.current !== key) return;

      setStreamInfo({
        wss: info.wss,
        mode: info.mode,
        expiresAt: info.expiresAt,
        camera: { ...cam, expiresAt: info.expiresAt },
      });
    } catch (err) {
      if (refreshKeyRef.current === key) {
        setStreamError((err as Error).message);
      }
    } finally {
      if (refreshKeyRef.current === key) {
        setStreamBusy(false);
      }
    }
  }, [stopActiveGresik]);

  const handleMapCameraSelect = useCallback((cam: Camera): void => {
    void openCamera(cam);
  }, [openCamera]);
  const handleMapWifiSelect = useCallback((id: number): void => {
    setSelectedWifiId(id);
  }, []);

  // Perbarui token stream URL sebelum kedaluwarsa (~5 mnt)
  const refreshStreamUrl = useCallback(
    async (slug: string): Promise<StreamInfo | null> => {
      // Sumber Madiun (primary IP/fallback), Magetan (Sarangan Vision) & Trenggalek (Portal TGX)
      // memakai URL statis, sehingga tidak ada signed URL yang perlu diperbarui.
      if (slug.startsWith('villabs-') || slug.startsWith('magetan-') || slug.startsWith('trenggalek-') || slug.startsWith('kediri-') || slug.startsWith('tulungagung-') || slug.startsWith('malang-') || slug.startsWith('mojokerto-') || slug.startsWith('surabaya-') || slug.startsWith('bojonegoro-') || slug.startsWith('gresik-') || slug.startsWith('tuban-') || slug.startsWith('banyuwangi-') || slug.startsWith('bondowoso-') || slug.startsWith('situbondo-') || slug.startsWith('pasuruan-')) {
        return null;
      }

      const info = await fetchStreamUrl(slug);
      let updatedInfo: StreamInfo | null = null;

      setStreamInfo((prev) => {
        if (!prev) return null;
        updatedInfo = {
          ...prev,
          wss: info.wss,
          mode: info.mode,
          expiresAt: info.expiresAt,
          camera: {
            ...prev.camera,
            expiresAt: info.expiresAt,
          },
        };
        return updatedInfo;
      });

      return updatedInfo;
    },
    []
  );

  const closePlayer = useCallback((): void => {
    refreshKeyRef.current++;
    if (activeSurabayaIdRef.current) {
      stopSurabayaStream(activeSurabayaIdRef.current);
      activeSurabayaIdRef.current = null;
    }
    stopActiveGresik();
    setFocusedLocation(null);
    setSelectedCamera(null);
    setStreamInfo(null);
    setStreamError('');
  }, [stopActiveGresik]);

  const focusOfflineCamera = useCallback((cam: Camera): void => {
    refreshKeyRef.current++;
    if (activeSurabayaIdRef.current) {
      stopSurabayaStream(activeSurabayaIdRef.current);
      activeSurabayaIdRef.current = null;
    }
    stopActiveGresik();
    setSelectedCamera(null);
    setSelectedCameraSlug(cam.slug);
    setStreamInfo(null);
    setStreamError('');
    setFocusedLocation({ latitude: cam.latitude, longitude: cam.longitude });
  }, [stopActiveGresik]);

  const handleSidebarCameraClick = useCallback((cam: Camera): void => {
    if (canPlayCamera(cam)) {
      void openCamera(cam);
      return;
    }

    focusOfflineCamera(cam);
  }, [focusOfflineCamera, openCamera]);

  // Tutup player dengan tombol Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && selectedCamera) {
        closePlayer();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedCamera, closePlayer]);

  const cameraSearchIndex = useMemo(() => {
    const index = new Map<string, string>();
    for (const camera of cameras) {
      index.set(camera.slug, `${camera.name} ${camera.location} ${camera.slug}`.toLowerCase());
    }
    return index;
  }, [cameras]);

  // Filter kamera & WiFi berdasarkan tab aktif ('all' | 'cctv' | 'wifi') & pencarian
  const sourceCounts = useMemo<Record<CameraSource, number>>(() => {
    const counts: Record<CameraSource, number> = {
      ponorogo: 0,
      madiun: 0,
      magetan: 0,
      trenggalek: 0,
      kediri: 0,
      tulungagung: 0,
      malang: 0,
      mojokerto: 0,
      surabaya: 0,
      bojonegoro: 0,
      gresik: 0,
      tuban: 0,
      banyuwangi: 0,
      bondowoso: 0,
      situbondo: 0,
      pasuruan: 0,
    };
    for (const camera of cameras) counts[cameraSource(camera)] += 1;
    return counts;
  }, [cameras]);
  // Pindah fokus peta saat filter sumber diubah
  const handleSourceChange = useCallback((source: SourceFilter): void => {
    setSourceFilter(source);
    setIsSourceFilterOpen(false);
    setFocusedLocation(null);
    const key = Date.now();
    if (source === 'madiun') {
      setMapFocus({ latitude: -7.6295, longitude: 111.5233, zoom: 13, key });
    } else if (source === 'magetan') {
      setMapFocus({ latitude: -7.6565, longitude: 111.302, zoom: 12, key });
    } else if (source === 'trenggalek') {
      setMapFocus({ latitude: -8.12, longitude: 111.62, zoom: 10, key });
    } else if (source === 'kediri') {
      setMapFocus({ latitude: -7.8167, longitude: 112.0165, zoom: 13, key });
    } else if (source === 'tulungagung') {
      setMapFocus({ latitude: -8.0646, longitude: 111.9007, zoom: 12, key });
    } else if (source === 'malang') {
      setMapFocus({ latitude: -7.98, longitude: 112.63, zoom: 12, key });
    } else if (source === 'mojokerto') {
      setMapFocus({ latitude: -7.63, longitude: 112.55, zoom: 11, key });
    } else if (source === 'surabaya') {
      setMapFocus({ latitude: -7.25, longitude: 112.75, zoom: 11, key });
    } else if (source === 'bojonegoro') {
      setMapFocus({ latitude: -7.15, longitude: 111.88, zoom: 11, key });
    } else if (source === 'gresik') {
      setMapFocus({ latitude: -6.9, longitude: 112.6, zoom: 10, key });
    } else if (source === 'tuban') {
      setMapFocus({ latitude: -6.9845, longitude: 111.936, zoom: 10, key });
    } else if (source === 'banyuwangi') {
      setMapFocus({ latitude: -8.2618, longitude: 114.1794, zoom: 9, key });
    } else if (source === 'bondowoso') {
      setMapFocus({ latitude: -7.921, longitude: 113.829, zoom: 13, key });
    } else if (source === 'situbondo') {
      setMapFocus({ latitude: -7.8062, longitude: 114.0393, zoom: 10, key });
    } else if (source === 'pasuruan') {
      setMapFocus({ latitude: -7.6339, longitude: 112.9079, zoom: 11, key });
    } else if (source === 'ponorogo') {
      setMapFocus({ latitude: -7.8694, longitude: 111.47, zoom: 12, key });
    } else {
      setMapFocus({ latitude: -7.75, longitude: 111.5, zoom: 9, key });
    }
  }, []);

  const filteredCameras = useMemo(() => {
    if (activeTab === 'wifi') return [];

    const q = deferredSearchQuery.trim().toLowerCase();
    return cameras.filter((camera) => {
      const searchKey = cameraSearchIndex.get(camera.slug) || '';
      const matchesSearch = !q || searchKey.includes(q);
      const matchesStatus = cameraStatusFilter === 'all' ||
        (cameraStatusFilter === 'active' ? canPlayCamera(camera) : !canPlayCamera(camera));
      const matchesSource = sourceFilter === 'all' || cameraSource(camera) === sourceFilter;
      return matchesSearch && matchesStatus && matchesSource;
    });
  }, [cameras, activeTab, deferredSearchQuery, cameraStatusFilter, sourceFilter, cameraSearchIndex]);

  const filteredWifi = useMemo(() => {
    if (activeTab === 'cctv') return [];

    const q = searchQuery.trim().toLowerCase();
    return wifiPoints.filter((wifi) => {
      const matchesSearch = !q ||
        wifi.name.toLowerCase().includes(q) ||
        wifi.location.toLowerCase().includes(q);
      const matchesStatus = wifiStatusFilter === 'all' ||
        (wifiStatusFilter === 'active' ? isWifiActive(wifi.status) : !isWifiActive(wifi.status));
      return matchesSearch && matchesStatus;
    });
  }, [wifiPoints, activeTab, searchQuery, wifiStatusFilter]);

  return (
    <div className="app">
      {/* ── Top Navigation Bar ── */}
      <header className="topbar">
        {/* Brand Kiri */}
        <div className="brand">
          <img
            src="/assets/icon-512.png"
            alt="Logo LENSAMAS"
            className="brand-logo-img"
          />
          <div className="brand-text">
            <div className="brand-title">
              LENSAMAS
            </div>
            <div className="brand-subtitle">
              Lensa Monitoring Area Strategis
            </div>
          </div>
        </div>

        {/* Aksi Kanan (Hanya Tombol Reload & Toggle Tema Mentok Kanan) */}
        <div className="topbar-actions">
          <button
            type="button"
            className="btn-icon"
            onClick={() => void loadData(true)}
            title="Refresh data"
            disabled={isRefreshing}
          >
            <RotateCcw size={16} className={isRefreshing ? 'is-spinning' : ''} />
          </button>

          {/* Toggle Light / Dark Mode (Mentok Kanan) */}
          <button
            type="button"
            className="theme-toggle-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            aria-label="Toggle tema"
          >
            {theme === 'dark' ? (
              <Sun size={17} className="theme-icon sun-icon" />
            ) : (
              <Moon size={17} className="theme-icon moon-icon" />
            )}
          </button>
        </div>
      </header>

      {/* ── Main Layout ── */}
      <main className="layout">
        {/* Sidebar */}
        <aside className="sidebar">
          {/* Header Tetap di Sidebar (Tidak ikut terscroll) */}
          <div className="sidebar-sticky-top">
            {/* Search Bar */}
            <div className="sidebar-search">
              <Search size={15} className="search-icon" />
              <input
                type="text"
                className="search-input"
                placeholder="Cari CCTV atau WiFi publik…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setSearchQuery('')}
                  title="Hapus pencarian"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Filter Tabs Kategori: Semua, CCTV, WiFi */}
            <div className="filter-tabs">
              <button
                type="button"
                className={`tab-btn ${activeTab === 'all' ? 'active' : ''}`}
                onClick={() => setActiveTab('all')}
              >
                <Layers size={13} />
                <span>Semua</span>
                <span className="tab-counter">{cameras.length + wifiPoints.length}</span>
              </button>
              <button
                type="button"
                className={`tab-btn tab-btn-cctv ${activeTab === 'cctv' ? 'active' : ''}`}
                onClick={() => setActiveTab('cctv')}
              >
                <Cctv size={13} />
                <span>CCTV</span>
                <span className="tab-counter count-cctv">{cameras.length}</span>
              </button>
              <button
                type="button"
                className={`tab-btn tab-btn-wifi ${activeTab === 'wifi' ? 'active' : ''}`}
                onClick={() => setActiveTab('wifi')}
              >
                <Wifi size={13} />
                <span>WiFi</span>
                <span className="tab-counter count-wifi">{wifiPoints.length}</span>
              </button>
            </div>

            <div className="toolbar-status-filter" role="group" aria-label="Filter status">
              {(['all', 'active', 'inactive'] as StatusFilter[]).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={`status-filter-btn ${(
                    activeTab === 'wifi' ? wifiStatusFilter : cameraStatusFilter
                  ) === filter ? 'active' : ''}`}
                  onClick={() => {
                    if (activeTab === 'wifi') setWifiStatusFilter(filter);
                    else setCameraStatusFilter(filter);
                  }}
                >
                  {filter === 'all' ? 'Semua' : filter === 'active' ? 'Aktif' : 'Nonaktif'}
                </button>
              ))}
            </div>

            {/* Filter sumber CCTV: ringkas secara default dan bisa dibuka saat diperlukan. */}
            {activeTab !== 'wifi' && (
              <div className="source-filter" role="group" aria-label="Filter sumber CCTV">
                <div className="source-filter-header">
                  <button
                    type="button"
                    className={`source-filter-toggle ${sourceFilter !== 'all' ? `src-${sourceFilter}` : ''}`}
                    onClick={() => setIsSourceFilterOpen((open) => !open)}
                    aria-expanded={isSourceFilterOpen}
                    aria-controls="source-filter-options"
                    title="Buka atau tutup pilihan sumber CCTV"
                  >
                    <span className="source-filter-heading">Sumber CCTV</span>
                    <span className="source-filter-selected">
                      {sourceFilter === 'all' ? 'Pilih sumber' : sourceLabel(sourceFilter)}
                    </span>
                    <span className="source-filter-selected-count">
                      {sourceFilter === 'all' ? cameras.length : sourceCounts[sourceFilter]}
                    </span>
                    <ChevronDown
                      size={14}
                      className={`source-filter-chevron ${isSourceFilterOpen ? 'is-open' : ''}`}
                    />
                  </button>
                  {sourceFilter !== 'all' && (
                    <button
                      type="button"
                      className="source-filter-clear"
                      onClick={() => handleSourceChange('all')}
                      title="Tampilkan semua sumber"
                      aria-label="Tampilkan semua sumber"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                {isSourceFilterOpen && (
                  <div id="source-filter-options" className="source-filter-options" role="group" aria-label="Daftar sumber CCTV">
                    {SOURCE_OPTIONS.map(({ id, title }) => {
                      const count = sourceCounts[id];
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`source-filter-btn src-${id} ${sourceFilter === id ? 'active' : ''}`}
                          onClick={() => handleSourceChange(id)}
                          title={title}
                        >
                          <span className="source-filter-name">{sourceLabel(id)}</span>
                          <span className="source-count">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {apiError && (
            <div className={`network-alert-card ${isUsingCache ? 'is-warning' : 'is-error'}`}>
              <div className="alert-icon-wrap">
                {isOffline ? <WifiOff size={16} /> : <CloudOff size={16} />}
              </div>
              <div className="alert-body">
                <div className="alert-header-row">
                  <span className="alert-badge">
                    {isOffline ? 'Offline' : 'Gangguan Server'}
                  </span>
                  {lastSyncTime && isUsingCache && (
                    <span className="alert-sync-time">
                      Tersimpan {formatSyncTime(lastSyncTime)}
                    </span>
                  )}
                </div>
                <div className="alert-message">{apiError}</div>
                {isUsingCache && (
                  <div className="alert-subtext">
                    Menampilkan data dari memori tersimpan agar lokasi di peta tetap dapat diakses.
                  </div>
                )}
              </div>
              <button
                type="button"
                className="alert-retry-btn"
                onClick={() => void loadData(true)}
                disabled={isRefreshing}
                title="Coba hubungkan kembali sekarang"
              >
                <RotateCcw size={12} className={isRefreshing ? 'is-spinning' : ''} />
                <span>{isRefreshing ? 'Menghubungkan…' : 'Coba Lagi'}</span>
              </button>
            </div>
          )}

          {/* Area Scroll Khusus dengan Scrollbar Custom & Sticky Headers Rapi */}
          <div className="sidebar-scroll-area custom-scrollbar">
            {/* List Kamera dengan Sticky Section Header Opaque Rapi */}
            {activeTab !== 'wifi' && (
              <div className="section-block">
                <div className="section-sticky-header">
                  <div className="section-title">
                    <Cctv size={15} className="text-sky" />
                    <span>Kamera CCTV ({filteredCameras.length})</span>
                  </div>
                  {loading && <Loader2 size={13} className="animate-spin text-muted" />}
                </div>

                <ul className="cam-list">
                  {filteredCameras.map((cam) => {
                    const isSelected = selectedCamera?.slug === cam.slug;
                    const isOnline = cam.status === 'online';
                    const isUnknownPlayable = cam.status === 'unknown' && Boolean(cam.streamUrl);
                    const statusClass = isOnline ? 'online' : isUnknownPlayable ? 'unknown' : 'offline';

                    return (
                      <li key={cam.slug}>
                        <button
                          type="button"
                          className={`cam-card ${isSelected ? 'active' : ''}`}
                          onClick={() => handleSidebarCameraClick(cam)}
                        >
                          <div className={`cam-status-pill ${statusClass}`}>
                            {isOnline || isUnknownPlayable ? <Video size={14} /> : <VideoOff size={14} />}
                          </div>

                          <div className="cam-info">
                            <div className="cam-name">{cam.name}</div>
                            <div className="cam-loc">
                              <MapPin size={11} className="loc-icon" />
                              <span>{cam.location}</span>
                            </div>
                          </div>

                          {cam.channel && (
                            <span className="cam-channel-tag">CH {cam.channel}</span>
                          )}

                          <span className={`cam-source-tag ${cameraSource(cam)}`}>
                            {sourceLabel(cameraSource(cam))}
                          </span>

                          <ChevronRight size={15} className="cam-chevron" />
                        </button>
                      </li>
                    );
                  })}

                  {filteredCameras.length === 0 && !loading && (
                    <li className="empty-state-box">
                      {apiError && !isUsingCache ? (
                        <>
                          <CloudOff size={28} className="empty-icon text-rose" />
                          <div className="empty-state-title">Tidak Dapat Mengambil Data CCTV</div>
                          <div className="empty-state-desc">
                            Server pusat Nawasara sedang tidak dapat dijangkau atau perangkat sedang offline.
                          </div>
                          <button
                            type="button"
                            className="alert-retry-btn"
                            onClick={() => void loadData(true)}
                            disabled={isRefreshing}
                            style={{ marginTop: 6 }}
                          >
                            <RotateCcw size={12} className={isRefreshing ? 'is-spinning' : ''} />
                            <span>Hubungkan Kembali</span>
                          </button>
                        </>
                      ) : (
                        <>
                          <VideoOff size={22} className="empty-icon" />
                          <div>Tidak ada CCTV yang cocok</div>
                        </>
                      )}
                    </li>
                  )}
                </ul>
              </div>
            )}

            {/* List WiFi dengan Sticky Section Header Opaque Rapi */}
            {activeTab !== 'cctv' && (
              <div className="section-block wifi-section-block">
                <div className="section-sticky-header">
                  <div className="section-title">
                    <Wifi size={15} className="text-purple" />
                    <span>Hotspot WiFi ({filteredWifi.length})</span>
                  </div>
                </div>

                <ul className="wifi-list">
                  {filteredWifi.map((wifi) => {
                    const isSelected = selectedWifiId === wifi.id;
                    return (
                      <li key={wifi.id}>
                        <button
                          type="button"
                          className={`wifi-card-btn ${isSelected ? 'active' : ''}`}
                          onClick={() => {
                            setSelectedWifiId(wifi.id);
                            setWifiFocusKey((prev) => prev + 1);
                            setFocusedLocation({ latitude: wifi.latitude, longitude: wifi.longitude });
                          }}
                          title="Klik untuk membuka lokasi & info WiFi di peta"
                        >
                          <div className="wifi-icon-wrap">
                            <Wifi size={14} />
                          </div>
                          <div className="cam-info">
                            <div className="cam-name">{wifi.name}</div>
                            <div className="cam-loc">
                              <MapPin size={11} className="loc-icon" />
                              <span>{wifi.location}</span>
                            </div>
                          </div>
                          <ChevronRight size={15} className="cam-chevron" />
                        </button>
                      </li>
                    );
                  })}

                  {filteredWifi.length === 0 && !loading && (
                    <li className="empty-state-box">
                      {apiError && !isUsingCache ? (
                        <>
                          <WifiOff size={28} className="empty-icon text-purple" />
                          <div className="empty-state-title">Tidak Dapat Memuat Hotspot WiFi</div>
                          <div className="empty-state-desc">
                            Gagal menghubungi server publik Nawasara.
                          </div>
                          <button
                            type="button"
                            className="alert-retry-btn"
                            onClick={() => void loadData(true)}
                            disabled={isRefreshing}
                            style={{ marginTop: 6 }}
                          >
                            <RotateCcw size={12} className={isRefreshing ? 'is-spinning' : ''} />
                            <span>Hubungkan Kembali</span>
                          </button>
                        </>
                      ) : (
                        <>
                          <Wifi size={22} className="empty-icon" />
                          <div>Tidak ada hotspot WiFi yang cocok</div>
                        </>
                      )}
                    </li>
                  )}
                </ul>
              </div>
            )}

            {/* Sidebar Footer (Collapsible) */}
            <footer className="sidebar-foot">
              <button
                type="button"
                className="foot-toggle-btn"
                onClick={() => setIsLegalOpen((prev) => !prev)}
                aria-expanded={isLegalOpen}
                title={isLegalOpen ? 'Tutup informasi layanan' : 'Buka informasi layanan & legalitas'}
              >
                <div className="foot-brand">
                  <ShieldCheck size={14} className="text-sky" />
                  <span>LENSAMAS</span>
                  <span className="foot-info-tag">Info Layanan</span>
                </div>
                <ChevronDown
                  size={14}
                  className={`foot-chevron ${isLegalOpen ? 'is-open' : ''}`}
                />
              </button>

              {isLegalOpen && (
                <div className="foot-legal-content">
                  <p>
                    Layanan pemantauan ruang publik se-Jawa Timur untuk mendukung transparansi dan keamanan publik, serta tunduk pada UU No. 27/2022 (PDP) dan Perpres No. 95/2018 (SPBE).
                  </p>
                </div>
              )}
            </footer>
          </div>
        </aside>

        {/* Interactive Map */}
        <section className="map-wrap">
          <MapView
            cameras={filteredCameras}
            wifiPoints={filteredWifi}
            selectedSlug={selectedCameraSlug}
            selectedCamera={selectedCamera}
            selectedWifiId={selectedWifiId}
            wifiFocusKey={wifiFocusKey}
            focusedLocation={focusedLocation}
            mapFocus={mapFocus}
            theme={theme}
            onSelect={handleMapCameraSelect}
            onSelectWifi={handleMapWifiSelect}
          />
        </section>
      </main>

      {/* ── Player Modal (CCTV Live Stream) ── */}
      {selectedCamera && (
        <div
          className="modal-backdrop"
          onClick={closePlayer}
          role="dialog"
          aria-modal="true"
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <CameraPlayer
              camera={streamInfo?.camera || selectedCamera}
              streamUrl={streamInfo?.wss || null}
              isLoadingUrl={streamBusy}
              streamError={streamError}
              onRefreshUrl={refreshStreamUrl}
              onClose={closePlayer}
              onRetry={() => void openCamera(selectedCamera)}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
