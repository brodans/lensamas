export type CameraSource =
  | 'ponorogo'
  | 'madiun'
  | 'magetan'
  | 'trenggalek'
  | 'kediri'
  | 'tulungagung'
  | 'malang'
  | 'mojokerto'
  | 'surabaya'
  | 'bojonegoro'
  | 'gresik'
  | 'tuban'
  | 'banyuwangi'
  | 'bondowoso'
  | 'situbondo'
  | 'pasuruan';

export interface Camera {
  slug: string;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status: 'online' | 'offline' | string;
  device_status?: string;
  last_seen_at?: string;
  channel?: number;
  codec?: string;
  expiresAt?: Date | null;
  /** Sumber data kamera. Default dianggap 'ponorogo' bila tidak diisi. */
  source?: CameraSource;
  /** Protokol live stream: go2rtc, jsmpeg, hls, atau FLV-over-WebSocket. */
  protocol?: 'go2rtc' | 'jsmpeg' | 'hls' | 'flv' | 'mjpeg';
  /** URL WebSocket/HLS langsung atau proxy untuk sumber yang tidak butuh signed URL. */
  streamUrl?: string;
  /** URL HLS langsung yang dicoba ketika proxy same-origin diblokir upstream. */
  fallbackStreamUrl?: string;
  /** Kode kamera pada penyedia sumber. */
  sourceCode?: string;
  /** URL thumbnail statis bila tersedia. */
  thumbUrl?: string;
  /** False bila stream MJPEG membutuhkan credential server yang belum diisi. */
  streamConfigured?: boolean;
}

export interface WifiPoint {
  id: number;
  name: string;
  location: string;
  latitude: number;
  longitude: number;
  status?: string;
  status_changed_at?: string;
}

export interface StreamResponseData {
  stream_url: string;
  mode: string;
  expires_at: string;
}

export interface StreamInfo {
  wss: string;
  mode: string;
  expiresAt: Date | null;
  camera: Camera;
}

export interface ApiResponse<T> {
  data: T;
  error?: string;
}

export type PlayerPhase = 'loading' | 'connecting' | 'live' | 'error' | 'offline';

export interface HTMLVideoElementWithCaptureStream extends HTMLVideoElement {
  captureStream?(fps?: number): MediaStream;
}

export interface VideoRTCElement extends HTMLElement {
  mode: string;
  media: string;
  src: string;
  wsState?: number;
  pcState?: number;
  video?: HTMLVideoElementWithCaptureStream;
  ondisconnect(): void;
}
