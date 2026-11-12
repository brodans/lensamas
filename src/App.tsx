import React, { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Cctv,
  Video,
  VideoOff,
  Search,
  X,
  MapPin,
  Loader2,
  RotateCcw,
  ChevronRight,
  ChevronDown,
  ShieldCheck,
  Sun,
  Moon,
  CloudOff,
} from 'lucide-react';
import MapView from './MapView';
import CameraPlayer from './CameraPlayer';
import {
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
  fetchNusantaraCameras,
  startSurabayaStream,
  stopSurabayaStream,
  startGresikStream,
  heartbeatGresikStream,
  stopGresikStream,
  getCachedCameras,
  getLastSyncTime,
  saveOfflineData,
  formatApiErrorMessage,
} from './api';
import type { Camera, CameraSource, StreamInfo } from './types';

type TabFilter = 'all' | 'cctv';
type StatusFilter = 'all' | 'active' | 'inactive';
type ThemeMode = 'dark' | 'light';
type SourceFilter = CameraSource | 'all';

function cameraSource(camera: Camera): CameraSource | undefined {
  return camera.source;
}

function sourceLabel(source: CameraSource | undefined): string {
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
  if (source === 'nusantara') return 'Nusantara';
  if (source === 'bandung') return 'Bandung';
  return 'Lainnya';
}


function canPlayCamera(camera: Camera): boolean {
  return camera.status === 'online' || (camera.status === 'unknown' && Boolean(camera.streamUrl));
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
  const [isUsingCache, setIsUsingCache] = useState<boolean>(() => getCachedCameras().length > 0);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(() => getLastSyncTime());
  const [isOffline, setIsOffline] = useState<boolean>(() => (typeof navigator !== 'undefined' ? !navigator.onLine : false));

  const [loading, setLoading] = useState<boolean>(() => getCachedCameras().length === 0);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [activeTab] = useState<TabFilter>('all');
  const [sourceFilter] = useState<SourceFilter>('all');
  const [regionFilter] = useState<string>('all');
  const [mapFocus] = useState<{ latitude: number; longitude: number; zoom: number; key: number } | null>(null);
  const [cameraStatusFilter, setCameraStatusFilter] = useState<StatusFilter>('all');
  const [isLegalOpen, setIsLegalOpen] = useState<boolean>(false);

  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [selectedCameraSlug, setSelectedCameraSlug] = useState<string | null>(null);

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

  // Muat daftar kamera dari API dengan ketahanan offline.
  const loadData = useCallback((isManualRefresh = false): Promise<void> => {
    if (loadInFlightRef.current) {
      if (!loadAbortRef.current?.signal.aborted) return loadInFlightRef.current;
      loadInFlightRef.current = null;
    }
    if (isManualRefresh) setIsRefreshing(true);

    const task = (async (): Promise<void> => {
      const controller = new AbortController();
      loadAbortRef.current = controller;
      const signal = controller.signal;
      try {
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
          nusantaraCams,
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
          fetchNusantaraCameras(signal),
        ]);
        if (controller.signal.aborted) return;
        const mergedCams = [
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
          ...nusantaraCams,
        ];
        startTransition(() => setCameras(mergedCams));
        saveOfflineData(mergedCams);
        setLastSyncTime(new Date().toISOString());
        setApiError('');
        setIsUsingCache(false);
      } catch (err) {
        if (controller.signal.aborted) return;
        setApiError(formatApiErrorMessage(err));
        const cachedCams = getCachedCameras();
        if (cachedCams.length > 0) {
          startTransition(() => setCameras(cachedCams));
          setIsUsingCache(true);
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

    // HLS, FLV, MJPEG, iframe, dan snapshot memiliki URL statis.
    if ((cam.protocol === 'hls' || cam.protocol === 'flv' || cam.protocol === 'mjpeg' || cam.protocol === 'iframe' || cam.protocol === 'snapshot') && (cam.streamUrl || cam.thumbUrl)) {
      setStreamBusy(false);
      setStreamInfo({
        wss: cam.streamUrl || cam.thumbUrl || '',
        mode: cam.protocol,
        expiresAt: null,
        camera: cam,
      });
      return;
    }

    setStreamBusy(false);
    setStreamError('Stream tidak tersedia untuk kamera ini.');
  }, [stopActiveGresik]);

  const handleMapCameraSelect = useCallback((cam: Camera): void => {
    void openCamera(cam);
  }, [openCamera]);
  // Stream regional memakai URL statis/proxy, tidak ada signed URL yang perlu diperbarui.
  const refreshStreamUrl = useCallback(
    async (_slug: string): Promise<StreamInfo | null> => null,
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

  // Filter kamera berdasarkan pencarian
  const filteredCameras = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase();
    return cameras.filter((camera) => {
      const searchKey = cameraSearchIndex.get(camera.slug) || '';
      const matchesSearch = !q || searchKey.includes(q);
      const matchesStatus = cameraStatusFilter === 'all' ||
        (cameraStatusFilter === 'active' ? canPlayCamera(camera) : !canPlayCamera(camera));
      const matchesSource = sourceFilter === 'all' || cameraSource(camera) === sourceFilter;
      const matchesRegion = regionFilter === 'all' || cameraSource(camera) !== 'nusantara' || camera.region === regionFilter;
      return matchesSearch && matchesStatus && matchesSource && matchesRegion;
    });
  }, [cameras, activeTab, deferredSearchQuery, cameraStatusFilter, sourceFilter, cameraSearchIndex]);

  // Peta: Pengadilan Agama dalam satu pengadilan digabung menjadi satu titik
  // (rata-rata koordinat kameranya) agar tidak bertumpuk dan lebih akurat.
  const mapCameras = useMemo<Camera[]>(() => {
    const paGroups = new Map<string, Camera[]>();
    const result: Camera[] = [];
    for (const camera of filteredCameras) {
      const isPA = camera.category === 'pengadilan' || (camera.sourceName || '').toLowerCase().includes('badilag');
      if (!isPA) {
        result.push(camera);
        continue;
      }
      const courtKey = (camera.location || camera.name).split('(')[0].trim() || camera.name;
      if (!paGroups.has(courtKey)) paGroups.set(courtKey, []);
      paGroups.get(courtKey)!.push(camera);
    }
    for (const cams of paGroups.values()) {
      if (cams.length === 1) {
        result.push(cams[0]);
        continue;
      }
      const lat = cams.reduce((s, c) => s + c.latitude, 0) / cams.length;
      const lng = cams.reduce((s, c) => s + c.longitude, 0) / cams.length;
      result.push({ ...cams[0], latitude: lat, longitude: lng });
    }
    return result;
  }, [filteredCameras]);

  const cameraGroup = useCallback((camera: Camera): string => {
    if (camera.category === 'pengadilan' || (camera.sourceName || '').toLowerCase().includes('badilag')) {
      return 'Pengadilan Agama';
    }
    if (cameraSource(camera) !== 'nusantara') {
      return sourceLabel(cameraSource(camera));
    }
    return camera.city || camera.region || 'Lainnya';
  }, []);

  const groupedCameras = useMemo<Array<[string, Camera[]]>>(() => {
    const groups = new Map<string, Camera[]>();
    for (const camera of filteredCameras) {
      const key = cameraGroup(camera);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(camera);
    }
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === 'Pengadilan Agama') return 1;
      if (b[0] === 'Pengadilan Agama') return -1;
      return a[0].localeCompare(b[0], 'id');
    });
  }, [filteredCameras, cameraGroup]);

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
                placeholder="Cari CCTV publik…"
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

            {/* Filter status kamera */}
            <div className="toolbar-status-filter" style={{ marginTop: 8 }} role="group" aria-label="Filter status">
              {(['all', 'active', 'inactive'] as StatusFilter[]).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={`status-filter-btn ${cameraStatusFilter === filter ? 'active' : ''}`}
                  onClick={() => setCameraStatusFilter(filter)}
                >
                  {filter === 'all' ? 'Semua' : filter === 'active' ? 'Aktif' : 'Nonaktif'}
                </button>
              ))}
            </div>

          </div>

          {apiError && (
            <div className={`network-alert-card ${isUsingCache ? 'is-warning' : 'is-error'}`}>
              <div className="alert-icon-wrap">
                <CloudOff size={16} />
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
            {true && (
              <div className="cam-group-list">
                {loading && <Loader2 size={13} className="animate-spin text-muted" style={{ margin: 8 }} />}
                  {groupedCameras.map(([group, cams]) => (
                    <div key={group} className="section-block" style={{ marginBottom: 8 }}>
                      <div className="section-sticky-header">
                        <div className="section-title">
                          <Cctv size={15} className="text-sky" />
                          <span>{group} ({cams.length})</span>
                        </div>
                      </div>
                      <ul className="cam-list">
                        {cams.map((cam) => {
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
                      </ul>
                    </div>
                  ))}

                  {filteredCameras.length === 0 && !loading && (
                    <div className="empty-state-box">
                      {apiError && !isUsingCache ? (
                        <>
                          <CloudOff size={28} className="empty-icon text-rose" />
                          <div className="empty-state-title">Tidak Dapat Mengambil Data CCTV</div>
                          <div className="empty-state-desc">
                            Server sumber sedang tidak dapat dijangkau atau perangkat sedang offline.
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
                    </div>
                  )}
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
            cameras={mapCameras}

            selectedSlug={selectedCameraSlug}
            selectedCamera={selectedCamera}
            focusedLocation={focusedLocation}
            mapFocus={mapFocus}
            theme={theme}
            onSelect={handleMapCameraSelect}
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
