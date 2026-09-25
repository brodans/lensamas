export declare class VideoRTC extends HTMLElement {
  DISCONNECT_TIMEOUT: number;
  RECONNECT_TIMEOUT: number;
  CODECS: string[];
  mode: string;
  media: string;
  background: boolean;
  visibilityThreshold: number;
  wsState?: number;
  pcState?: number;
  video?: HTMLVideoElement;
  src: string;
  ondisconnect(): void;
}
