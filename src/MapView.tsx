import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Tooltip,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import ZoomControls from './ZoomControls';
import type { Camera, WifiPoint } from './types';

// Pembuatan DivIcon kustom untuk CCTV dengan icon CCTV resmi Lucide React
function createCameraMarkerIcon(
  status: string,
  isSelected: boolean,
  source: Camera['source'] = 'ponorogo'
): L.DivIcon {
  const isOnline = status === 'online';
  const isUnknown = status === 'unknown';
  const sourceKey = source ?? 'ponorogo';
  const sourceColors: Record<string, string> = {
    ponorogo: '#10b981',
    madiun: '#38bdf8',
    magetan: '#f59e0b',
    trenggalek: '#a855f7',
    kediri: '#0f766e',
    tulungagung: '#2563eb',
    malang: '#be123c',
    mojokerto: '#059669',
    surabaya: '#db2777',
    bojonegoro: '#ea580c',
    gresik: '#0891b2',
    tuban: '#84cc16',
    banyuwangi: '#14b8a6',
    bondowoso: '#d97706',
    situbondo: '#6366f1',
    pasuruan: '#c026d3',
  };
  const sourceLabels: Record<string, string> = {
    ponorogo: 'Ponorogo',
    madiun: 'Madiun',
    magetan: 'Magetan',
    trenggalek: 'Trenggalek',
    kediri: 'Kediri',
    tulungagung: 'Tulungagung',
    malang: 'Malang',
    mojokerto: 'Mojokerto',
    surabaya: 'Surabaya',
    bojonegoro: 'Bojonegoro',
    gresik: 'Gresik',
    tuban: 'Tuban',
    banyuwangi: 'Banyuwangi',
    bondowoso: 'Bondowoso',
    situbondo: 'Situbondo',
    pasuruan: 'Pasuruan',
  };
  const sourceBadges: Record<string, string> = {
    madiun: 'M',
    magetan: 'G',
    trenggalek: 'T',
    kediri: 'K',
    tulungagung: 'T',
    malang: 'M',
    mojokerto: 'J',
    surabaya: 'S',
    bojonegoro: 'B',
    gresik: 'G',
    tuban: 'T',
    banyuwangi: 'B',
    bondowoso: 'B',
    situbondo: 'S',
    pasuruan: 'P',
  };
  const color = isOnline || isUnknown ? (sourceColors[sourceKey] || sourceColors.ponorogo) : '#6b7280';
  const pulseClass = isOnline ? 'marker-pulse-online' : '';
  const selectedClass = isSelected ? 'marker-selected' : '';
  const sourceClass = `marker-source-${sourceKey}`;
  const sourceName = sourceLabels[sourceKey] || sourceLabels.ponorogo;
  const sourceBadge = sourceBadges[sourceKey] || '';

  return L.divIcon({
    className: 'custom-leaflet-marker',
    html: `
      <div class="camera-marker-pin ${pulseClass} ${selectedClass} ${sourceClass}" style="--marker-color: ${color}">
        <div class="pin-inner" title="CCTV ${sourceName} (${isOnline ? 'Online' : isUnknown ? 'Status belum dilaporkan' : 'Offline'})">
          <!-- Icon CCTV Lucide React Resmi -->
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16.75 12h3.632a1 1 0 0 1 .894 1.447l-2.034 4.069a1 1 0 0 1-1.708.134l-2.124-2.97"/>
            <path d="M17.106 9.053a1 1 0 0 1 .447 1.341l-3.106 6.211a1 1 0 0 1-1.342.447L3.61 12.3a2.92 2.92 0 0 1-1.3-3.91L3.69 5.6a2.92 2.92 0 0 1 3.92-1.3z"/>
            <path d="M2 19h3.76a2 2 0 0 0 1.8-1.1L9 15"/>
            <path d="M2 21v-4"/>
            <path d="M7 9h.01"/>
          </svg>
        </div>
        ${sourceBadge ? `<div class="pin-source-badge ${source}">${sourceBadge}</div>` : ''}
        <div class="pin-pointer"></div>
      </div>
    `,
    iconSize: [36, 44],
    iconAnchor: [18, 44],
    popupAnchor: [0, -44],
  });
}

// Pembuatan DivIcon kustom untuk WiFi Hotspot dengan icon Wifi resmi Lucide React
function createWifiMarkerIcon(isSelected = false): L.DivIcon {
  const selectedClass = isSelected ? 'marker-selected' : '';
  return L.divIcon({
    className: 'custom-leaflet-marker',
    html: `
      <div class="wifi-marker-pin ${selectedClass}" title="Klik untuk membuka info WiFi">
        <div class="wifi-pin-inner">
          <!-- Icon Wifi Lucide React Resmi -->
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h.01"/>
            <path d="M2 8.82a15 15 0 0 1 20 0"/>
            <path d="M5 12.859a10 10 0 0 1 14 0"/>
            <path d="M8.5 16.429a5 5 0 0 1 7 0"/>
          </svg>
        </div>
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  });
}

// Cache icon marker agar tidak membuat DOM instance baru berulang-ulang pada setiap render
const cameraIconCache = new Map<string, L.DivIcon>();
function getCameraMarkerIcon(
  status: string,
  isSelected: boolean,
  source: Camera['source'] = 'ponorogo'
): L.DivIcon {
  const key = `${status}-${isSelected}-${source ?? 'ponorogo'}`;
  let icon = cameraIconCache.get(key);
  if (!icon) {
    icon = createCameraMarkerIcon(status, isSelected, source);
    cameraIconCache.set(key, icon);
  }
  return icon;
}

const wifiIconCache = new Map<boolean, L.DivIcon>();
function getWifiMarkerIcon(isSelected = false): L.DivIcon {
  let icon = wifiIconCache.get(isSelected);
  if (!icon) {
    icon = createWifiMarkerIcon(isSelected);
    wifiIconCache.set(isSelected, icon);
  }
  return icon;
}

interface MapFocus {
  latitude: number;
  longitude: number;
  zoom: number;
  key: number;
}

interface CameraCluster {
  key: string;
  latitude: number;
  longitude: number;
  cameras: Camera[];
}

type CameraRenderItem =
  | { type: 'camera'; camera: Camera }
  | { type: 'cluster'; cluster: CameraCluster };

const CAMERA_CLUSTER_MIN_COUNT = 300;
const CAMERA_CLUSTER_MAX_ZOOM = 14;

function buildCameraRenderItems(
  cameras: Camera[],
  zoom: number,
  selectedSlug?: string | null,
  bounds?: L.LatLngBounds | null
): CameraRenderItem[] {
  const visibleCameras = bounds && cameras.length >= CAMERA_CLUSTER_MIN_COUNT
    ? cameras.filter((camera) => camera.slug === selectedSlug || bounds.contains([camera.latitude, camera.longitude]))
    : cameras;
  if (visibleCameras.length < CAMERA_CLUSTER_MIN_COUNT || zoom > CAMERA_CLUSTER_MAX_ZOOM) {
    return visibleCameras.map((camera) => ({ type: 'camera' as const, camera }));
  }

  const cellSize = Math.max(0.002, (360 / (256 * (2 ** zoom))) * 52);
  const groups = new Map<string, Camera[]>();
  for (const camera of visibleCameras) {
    if (camera.slug === selectedSlug) continue;
    const key = `${Math.round(camera.latitude / cellSize)}:${Math.round(camera.longitude / cellSize)}`;
    const group = groups.get(key);
    if (group) group.push(camera);
    else groups.set(key, [camera]);
  }

  const items: CameraRenderItem[] = [];
  if (selectedSlug) {
    const selected = cameras.find((camera) => camera.slug === selectedSlug);
    if (selected) items.push({ type: 'camera', camera: selected });
  }
  for (const [key, group] of groups) {
    if (group.length === 1) {
      items.push({ type: 'camera', camera: group[0] });
      continue;
    }
    items.push({
      type: 'cluster',
      cluster: {
        key: `cluster-${key}`,
        latitude: group.reduce((sum, camera) => sum + camera.latitude, 0) / group.length,
        longitude: group.reduce((sum, camera) => sum + camera.longitude, 0) / group.length,
        cameras: group,
      },
    });
  }
  return items;
}

function MapZoomListener({ onChange }: { onChange: (zoom: number) => void }): null {
  const map = useMap();
  useEffect(() => {
    const handleZoom = (): void => onChange(map.getZoom());
    handleZoom();
    map.on('zoomend', handleZoom);
    return () => {
      map.off('zoomend', handleZoom);
    };
  }, [map, onChange]);
  return null;
}

function MapBoundsListener({ onChange }: { onChange: (bounds: L.LatLngBounds) => void }): null {
  const map = useMap();
  useEffect(() => {
    const handleBounds = (): void => onChange(map.getBounds());
    handleBounds();
    map.on('moveend', handleBounds);
    map.on('zoomend', handleBounds);
    return () => {
      map.off('moveend', handleBounds);
      map.off('zoomend', handleBounds);
    };
  }, [map, onChange]);
  return null;
}

interface CameraClusterMarkerProps {
  cluster: CameraCluster;
  zoom: number;
}

const CameraClusterMarker = React.memo<CameraClusterMarkerProps>(({ cluster, zoom }) => {
  const map = useMap();
  const icon = useMemo(
    () => L.divIcon({
      className: 'camera-cluster-marker-wrap',
      html: `<div class="camera-cluster-marker" title="${cluster.cameras.length} kamera CCTV">${cluster.cameras.length}</div>`,
      iconSize: [42, 42],
      iconAnchor: [21, 21],
    }),
    [cluster.cameras.length]
  );
  return (
    <Marker
      position={[cluster.latitude, cluster.longitude]}
      icon={icon}
      eventHandlers={{
        click: () => map.setView(
          [cluster.latitude, cluster.longitude],
          Math.min(zoom + 2, 18),
          { animate: true }
        ),
      }}
    >
      <Popup className="lensamas-popup">
        <div className="popup-card cluster-popup-card">
          <div className="popup-title">{cluster.cameras.length} kamera CCTV</div>
          <div className="popup-loc">Klik marker untuk memperbesar area.</div>
          <div className="cluster-preview-list">
            {cluster.cameras.slice(0, 6).map((camera) => (
              <span key={camera.slug}>{camera.name}</span>
            ))}
            {cluster.cameras.length > 6 && <span>+{cluster.cameras.length - 6} kamera lainnya</span>}
          </div>
        </div>
      </Popup>
    </Marker>
  );
});
CameraClusterMarker.displayName = 'CameraClusterMarker';

interface MapControllerProps {
  items: Array<{ latitude: number; longitude: number }>;
  selectedCamera?: Camera | null;
  focusedLocation?: { latitude: number; longitude: number } | null;
  mapFocus?: MapFocus | null;
}

// Pengontrol peta responsif (auto-resize, fitBounds, & flyTo)
function MapController({ items, selectedCamera, focusedLocation, mapFocus }: MapControllerProps): null {
  const map = useMap();
  const hasFittedRef = useRef(false);
  const lastFitItemCountRef = useRef(0);
  const skipNextAutoFitRef = useRef(false);

  useEffect(() => {
    map.invalidateSize();
    const timer = window.setTimeout(() => {
      map.invalidateSize();
    }, 250);

    const handleResize = (): void => {
      map.invalidateSize({ animate: false });
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    window.visualViewport?.addEventListener('resize', handleResize);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
      window.visualViewport?.removeEventListener('resize', handleResize);
    };
  }, [map]);

  // Fit bounds pada pemuatan awal
  useEffect(() => {
    if (skipNextAutoFitRef.current) {
      skipNextAutoFitRef.current = false;
      return;
    }
    if (!items.length || selectedCamera || focusedLocation || mapFocus) return;
    if (hasFittedRef.current && items.length <= lastFitItemCountRef.current) return;
    const coords: [number, number][] = items.map((i) => [i.latitude, i.longitude]);
    const bounds = L.latLngBounds(coords);
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.12));
      hasFittedRef.current = true;
      lastFitItemCountRef.current = items.length;
    }
  }, [items, map, selectedCamera, focusedLocation, mapFocus]);

  // Terbang ke koordinat kamera jika dipilih
  useEffect(() => {
    if (selectedCamera) {
      skipNextAutoFitRef.current = true;
      map.flyTo([selectedCamera.latitude, selectedCamera.longitude], 16, {
        duration: 1.2,
      });
    }
  }, [selectedCamera, map]);

  // Terbang ke koordinat lokasi umum jika diarahkan dari sidebar
  useEffect(() => {
    if (focusedLocation) {
      map.flyTo([focusedLocation.latitude, focusedLocation.longitude], 16, {
        duration: 1.2,
      });
    }
  }, [focusedLocation, map]);

  // Terbang ke area sumber CCTV (Ponorogo / Madiun) ketika filter sumber berubah
  useEffect(() => {
    if (!mapFocus) return;
    map.flyTo([mapFocus.latitude, mapFocus.longitude], mapFocus.zoom, {
      duration: 1.4,
    });
    // Bergantung pada mapFocus.key agar flyTo dipicu ulang walau koordinat sama
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapFocus?.key, map]);

  return null;
}

interface CameraMarkerItemProps {
  camera: Camera;
  isSelected: boolean;
  onSelect: (cam: Camera) => void;
}

function sameCameraMarkerProps(
  previous: CameraMarkerItemProps,
  next: CameraMarkerItemProps
): boolean {
  const a = previous.camera;
  const b = next.camera;
  return previous.isSelected === next.isSelected &&
    previous.onSelect === next.onSelect &&
    a.slug === b.slug &&
    a.name === b.name &&
    a.location === b.location &&
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    a.status === b.status &&
    a.source === b.source &&
    a.protocol === b.protocol &&
    a.streamUrl === b.streamUrl &&
    a.sourceCode === b.sourceCode &&
    a.device_status === b.device_status;
}

// Marker CCTV yang ter-memoize untuk mencegah render ulang saat pencarian atau ganti tab
const CameraMarkerItem = React.memo<CameraMarkerItemProps>(({ camera, isSelected, onSelect }) => {
  const isOnline = camera.status === 'online';
  const isUnknown = camera.status === 'unknown';
  const canPlay = isOnline || (isUnknown && Boolean(camera.streamUrl));
  const statusClass = isOnline ? 'online' : isUnknown ? 'unknown' : 'offline';
  const statusLabel = isOnline ? 'Online' : isUnknown ? 'Status belum dilaporkan' : 'Offline';
  const markerRef = useRef<L.Marker | null>(null);
  const icon = useMemo(
    () => getCameraMarkerIcon(camera.status, isSelected, camera.source),
    [camera.status, isSelected, camera.source]
  );

  useEffect(() => {
    if (isSelected && markerRef.current) markerRef.current.openPopup();
  }, [isSelected]);

  return (
    <Marker ref={markerRef} position={[camera.latitude, camera.longitude]} icon={icon}>
      <Tooltip direction="top" offset={[0, -42]} opacity={0.96} className="lensamas-tooltip">
        <div className="tooltip-inner">
          <b>{camera.name}</b>
          <div className={`status-badge-mini ${statusClass}`}>
            ● {statusLabel}
          </div>
        </div>
      </Tooltip>

      <Popup className="lensamas-popup">
        <div className="popup-card">
          <div className="popup-badge-row">
            <span className={`popup-status ${statusClass}`}>
              {isOnline ? '● Online' : isUnknown ? '? Status belum dilaporkan' : '○ Offline'}
            </span>
            {camera.channel && <span className="popup-channel">CH {camera.channel}</span>}
            {camera.source === 'madiun' && (
              <span className="popup-source-badge madiun">Madiun</span>
            )}
            {camera.source === 'magetan' && (
              <span className="popup-source-badge magetan">Magetan</span>
            )}
            {camera.source === 'trenggalek' && (
              <span className="popup-source-badge trenggalek">Trenggalek</span>
            )}
            {camera.source === 'kediri' && (
              <span className="popup-source-badge kediri">Kediri</span>
            )}
            {camera.source === 'tulungagung' && (
              <span className="popup-source-badge tulungagung">Tulungagung</span>
            )}
            {camera.source === 'malang' && (
              <span className="popup-source-badge malang">Malang</span>
            )}
            {camera.source === 'mojokerto' && (
              <span className="popup-source-badge mojokerto">Mojokerto</span>
            )}
            {camera.source === 'surabaya' && (
              <span className="popup-source-badge surabaya">Surabaya</span>
            )}
            {camera.source === 'bojonegoro' && (
              <span className="popup-source-badge bojonegoro">Bojonegoro</span>
            )}
            {camera.source === 'gresik' && (
              <span className="popup-source-badge gresik">Gresik</span>
            )}
            {camera.source === 'tuban' && (
              <span className="popup-source-badge tuban">Tuban</span>
            )}
            {camera.source === 'banyuwangi' && (
              <span className="popup-source-badge banyuwangi">Banyuwangi</span>
            )}
            {camera.source === 'bondowoso' && (
              <span className="popup-source-badge bondowoso">Bondowoso</span>
            )}
            {camera.source === 'situbondo' && (
              <span className="popup-source-badge situbondo">Situbondo</span>
            )}
            {camera.source === 'pasuruan' && (
              <span className="popup-source-badge pasuruan">Pasuruan</span>
            )}
          </div>

          <div className="popup-title">{camera.name}</div>
          <div className="popup-loc">{camera.location}</div>

          {canPlay ? (
            <button
              type="button"
              className="popup-play-btn"
              onClick={() => onSelect(camera)}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <span>Tonton Live Stream</span>
            </button>
          ) : (
            <div className="popup-unavailable">Tidak tersedia</div>
          )}
        </div>
      </Popup>
    </Marker>
  );
}, sameCameraMarkerProps);
CameraMarkerItem.displayName = 'CameraMarkerItem';

interface WifiMarkerItemProps {
  wifi: WifiPoint;
  isSelected: boolean;
  focusKey?: number;
  onSelect?: (id: number) => void;
}

function sameWifiMarkerProps(
  previous: WifiMarkerItemProps,
  next: WifiMarkerItemProps
): boolean {
  return previous.isSelected === next.isSelected &&
    previous.focusKey === next.focusKey &&
    previous.onSelect === next.onSelect &&
    previous.wifi.id === next.wifi.id &&
    previous.wifi.name === next.wifi.name &&
    previous.wifi.location === next.wifi.location &&
    previous.wifi.latitude === next.wifi.latitude &&
    previous.wifi.longitude === next.wifi.longitude &&
    previous.wifi.status === next.wifi.status;
}

// Marker item WiFi yang otomatis membuka popup ketika dipilih dari sidebar atau peta
const WifiMarkerItem = React.memo<WifiMarkerItemProps>(({
  wifi,
  isSelected,
  focusKey = 0,
  onSelect,
}) => {
  const markerRef = useRef<L.Marker | null>(null);
  const icon = useMemo(() => getWifiMarkerIcon(isSelected), [isSelected]);

  useEffect(() => {
    if (isSelected && markerRef.current) {
      markerRef.current.openPopup();
      const timer = window.setTimeout(() => {
        if (markerRef.current) {
          markerRef.current.openPopup();
        }
      }, 350);
      return () => window.clearTimeout(timer);
    }
  }, [isSelected, focusKey]);

  return (
    <Marker
      ref={markerRef}
      position={[wifi.latitude, wifi.longitude]}
      icon={icon}
      eventHandlers={{
        click: () => {
          onSelect?.(wifi.id);
        },
      }}
    >
      <Tooltip direction="top" offset={[0, -16]} opacity={0.96} className="lensamas-tooltip">
        <div className="tooltip-inner">
          <b>{wifi.name}</b>
          <div className="tooltip-muted">{wifi.location}</div>
        </div>
      </Tooltip>

      <Popup className="lensamas-popup" autoPan={false}>
        <div className="popup-card">
          <div className="popup-badge-row">
            <span className="popup-wifi-tag">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 20h.01"/>
                <path d="M2 8.82a15 15 0 0 1 20 0"/>
                <path d="M5 12.859a10 10 0 0 1 14 0"/>
                <path d="M8.5 16.429a5 5 0 0 1 7 0"/>
              </svg>
              <span>WiFi Publik</span>
            </span>
            <span className="popup-status online">● Terhubung</span>
          </div>

          <div className="popup-title">{wifi.name}</div>
          <div className="popup-loc">{wifi.location}</div>

          <a
            href={`https://www.google.com/maps/search/?api=1&query=${wifi.latitude},${wifi.longitude}`}
            target="_blank"
            rel="noopener noreferrer"
            className="popup-gmaps-btn"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="3 11 22 2 13 21 11 13 3 11"/>
            </svg>
            <span>Buka di Google Maps</span>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </a>
        </div>
      </Popup>
    </Marker>
  );
}, sameWifiMarkerProps);
WifiMarkerItem.displayName = 'WifiMarkerItem';

interface MapViewProps {
  cameras: Camera[];
  wifiPoints: WifiPoint[];
  selectedSlug?: string | null;
  selectedCamera?: Camera | null;
  selectedWifiId?: number | null;
  wifiFocusKey?: number;
  focusedLocation?: { latitude: number; longitude: number } | null;
  mapFocus?: MapFocus | null;
  theme?: 'dark' | 'light';
  onSelect: (camera: Camera) => void;
  onSelectWifi?: (id: number) => void;
}

const MapView: React.FC<MapViewProps> = ({
  cameras,
  wifiPoints,
  selectedSlug,
  selectedCamera,
  selectedWifiId,
  wifiFocusKey,
  focusedLocation,
  mapFocus,
  theme = 'dark',
  onSelect,
  onSelectWifi,
}) => {
  const [mapZoom, setMapZoom] = useState(14);
  const [mapBounds, setMapBounds] = useState<L.LatLngBounds>(() => L.latLngBounds([-90, -180], [90, 180]));
  const handleZoomChange = useCallback((zoom: number): void => {
    setMapZoom(zoom);
  }, []);
  const handleBoundsChange = useCallback((bounds: L.LatLngBounds): void => {
    setMapBounds(bounds);
  }, []);
  const cameraRenderItems = useMemo(
    () => buildCameraRenderItems(cameras, mapZoom, selectedSlug, mapBounds),
    [cameras, mapZoom, selectedSlug, mapBounds]
  );
  const allCoordinates = useMemo(
    () => [...cameras, ...wifiPoints].map((item) => ({ latitude: item.latitude, longitude: item.longitude })),
    [cameras, wifiPoints]
  );

  // Gunakan OpenStreetMap tanpa API key; tile gelap diberi filter pada pane peta.
  const tileConfig = useMemo(() => {
    if (theme === 'dark') {
      return {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        subdomains: ['a', 'b', 'c'],
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
        maxZoom: 19,
      };
    }
    return {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      subdomains: ['a', 'b', 'c'],
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
      maxZoom: 19,
    };
  }, [theme]);

  return (
    <MapContainer
      center={[-7.8694, 111.47]}
      zoom={14}
      className="lensamas-map"
      scrollWheelZoom
      zoomControl={false}
    >
      <TileLayer
        attribution={tileConfig.attribution}
        url={tileConfig.url}
        subdomains={tileConfig.subdomains}
        maxZoom={tileConfig.maxZoom}
      />

      <ZoomControls defaultCenter={[-7.8694, 111.47]} defaultZoom={14} />

      <MapController
        items={allCoordinates}
        selectedCamera={selectedCamera}
        focusedLocation={focusedLocation}
        mapFocus={mapFocus}
      />
      <MapZoomListener onChange={handleZoomChange} />
      <MapBoundsListener onChange={handleBoundsChange} />

      {/* Markers CCTV (Memoized + clustering untuk data besar) */}
      {cameraRenderItems.map((item) => item.type === 'camera' ? (
        <CameraMarkerItem
          key={item.camera.slug}
          camera={item.camera}
          isSelected={item.camera.slug === selectedSlug}
          onSelect={onSelect}
        />
      ) : (
        <CameraClusterMarker
          key={item.cluster.key}
          cluster={item.cluster}
          zoom={mapZoom}
        />
      ))}

      {/* Markers WiFi dengan Popup Otomatis Terbuka Saat Dipilih */}
      {wifiPoints.map((wifi) => (
        <WifiMarkerItem
          key={`wifi-${wifi.id}`}
          wifi={wifi}
          isSelected={wifi.id === selectedWifiId}
          focusKey={wifiFocusKey}
          onSelect={onSelectWifi}
        />
      ))}
    </MapContainer>
  );
};

export default MapView;
