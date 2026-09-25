import React, { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { Plus, Minus, Compass } from 'lucide-react';

interface ZoomControlsProps {
  defaultCenter?: [number, number];
  defaultZoom?: number;
}

const ZoomControls: React.FC<ZoomControlsProps> = ({
  defaultCenter = [-7.8694, 111.47],
  defaultZoom = 14,
}) => {
  const map = useMap();
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Cegah drag atau click map terpancing saat mengklik tombol kontrol zoom
  useEffect(() => {
    if (containerRef.current) {
      L.DomEvent.disableClickPropagation(containerRef.current);
      L.DomEvent.disableScrollPropagation(containerRef.current);
    }
  }, []);

  const handleZoomIn = (e: React.MouseEvent): void => {
    e.stopPropagation();
    map.zoomIn();
  };

  const handleZoomOut = (e: React.MouseEvent): void => {
    e.stopPropagation();
    map.zoomOut();
  };

  const handleResetView = (e: React.MouseEvent): void => {
    e.stopPropagation();
    map.flyTo(defaultCenter, defaultZoom, { duration: 1 });
  };

  return (
    <div className="custom-zoom-controls" ref={containerRef}>
      <button
        type="button"
        className="zoom-btn zoom-in-btn"
        onClick={handleZoomIn}
        title="Perbesar Peta (Zoom In)"
        aria-label="Perbesar peta"
      >
        <Plus size={16} strokeWidth={2.4} />
      </button>

      <div className="zoom-btn-divider" />

      <button
        type="button"
        className="zoom-btn zoom-out-btn"
        onClick={handleZoomOut}
        title="Perkecil Peta (Zoom Out)"
        aria-label="Perkecil peta"
      >
        <Minus size={16} strokeWidth={2.4} />
      </button>

      <div className="zoom-btn-divider" />

      <button
        type="button"
        className="zoom-btn zoom-reset-btn"
        onClick={handleResetView}
        title="Pusatkan Kembali Peta Ponorogo"
        aria-label="Pusatkan peta"
      >
        <Compass size={15} strokeWidth={2.2} />
      </button>
    </div>
  );
};

export default ZoomControls;
