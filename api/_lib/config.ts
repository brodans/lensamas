import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vite memuat .env melalui loadEnv(), tetapi modul API diimpor sebelum callback
// config dievaluasi. Loader kecil ini membuat nilai .env tetap tersedia untuk
// handler server-side pada dev/preview tanpa pernah mengeksposnya ke browser.
function loadLocalEnvFile(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // Environment variables from the process still take precedence.
  }
}

loadLocalEnvFile();

function envValue(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export const API_BASE_URL = envValue('API_BASE_URL', 'https://nawasara.ponorogo.go.id');
export const API_ORIGIN = envValue('API_ORIGIN', 'https://gasta.ponorogo.go.id');
export const APP_ORIGIN = envValue('APP_ORIGIN', '');
export const API_TOKEN = process.env.API_TOKEN?.trim();

export const MADIUN_PRIMARY_API_URL = envValue(
  'MADIUN_PRIMARY_API_URL',
  'https://103.149.120.205/api/app/camera/'
);
export const MADIUN_PRIMARY_TLS_HOST = envValue(
  'MADIUN_PRIMARY_TLS_HOST',
  'cctv.villabs.id'
);
export const MADIUN_PRIMARY_USER_AGENT = envValue(
  'MADIUN_PRIMARY_USER_AGENT',
  'Mozilla/5.0 (compatible; LENSAMAS CCTV proxy/1.0)'
);
export const MADIUN_API_URL = envValue(
  'MADIUN_API_URL',
  'https://cctv.villabs.id/api/app/camera/'
);
export const MADIUN_ORIGIN = envValue('MADIUN_ORIGIN', 'https://cctv.villabs.id');
export const MADIUN_STREAM_BASE = envValue(
  'MADIUN_STREAM_BASE',
  'wss://cctv.villabs.id/streamer-jsmpeg/streamer'
);

export const MAGETAN_LIST_URL = envValue(
  'MAGETAN_LIST_URL',
  'https://cctv.saranganvision.com/'
);
export const MAGETAN_ALLOWED_HOSTS = new Set(
  envValue(
    'MAGETAN_ALLOWED_HOSTS',
    'saranganvision.my.id,www.saranganvision.my.id,cctv.saranganvision.com'
  )
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);

export const TRENGGALEK_GEOTIK_LIST_URL = envValue(
  'TRENGGALEK_GEOTIK_LIST_URL',
  'https://geotik.trenggalekkab.go.id/home/get_cctv'
);
export const TRENGGALEK_GEOTIK_ORIGIN = envValue(
  'TRENGGALEK_GEOTIK_ORIGIN',
  new URL(TRENGGALEK_GEOTIK_LIST_URL).origin
);
export const TRENGGALEK_STREAM_HOST = envValue(
  'TRENGGALEK_STREAM_HOST',
  'stream.trenggalekkab.go.id'
);
export const TRENGGALEK_LIST_URL = envValue(
  'TRENGGALEK_LIST_URL',
  'https://tgxportal.trenggalekkab.go.id/cctv/show'
);
export const TRENGGALEK_ORIGIN = envValue(
  'TRENGGALEK_ORIGIN',
  'https://tgxportal.trenggalekkab.go.id'
);

export const MALANG_API_URL = envValue(
  'MALANG_API_URL',
  'https://cctv.malangkota.go.id/api/v2/get-cameras'
);
export const MALANG_PAGE_URL = envValue(
  'MALANG_PAGE_URL',
  'https://cctv.malangkota.go.id/sebaran-cctv'
);
export const MALANG_STREAM_BASE = envValue(
  'MALANG_STREAM_BASE',
  'https://cctv.malangkota.go.id/cctv-stream/streams'
);
export const MALANG_ORIGIN = envValue(
  'MALANG_ORIGIN',
  new URL(MALANG_PAGE_URL).origin
);
export const MALANG_DISTRICT_ID = envValue('MALANG_DISTRICT_ID', '99');

export const MOJOKERTO_LIST_URL = envValue(
  'MOJOKERTO_LIST_URL',
  'https://dishubcctv.mojokertokab.go.id/api/master/perangkat/all-cctv'
);
export const MOJOKERTO_ORIGIN = envValue(
  'MOJOKERTO_ORIGIN',
  'https://dishubcctv.mojokertokab.go.id'
);
export const MOJOKERTO_STREAM_BASE = envValue(
  'MOJOKERTO_STREAM_BASE',
  'wss://dishubstreaming.mojokertokab.go.id/rtsp'
);

export const TULUNGAGUNG_LIST_URL = envValue(
  'TULUNGAGUNG_LIST_URL',
  'https://cctvdishub.tulungagung.go.id/__data.json'
);
export const TULUNGAGUNG_STREAM_BASE = envValue(
  'TULUNGAGUNG_STREAM_BASE',
  'https://cctvdishub.tulungagung.go.id/api'
);

// Deployment-specific upstream; keep the value in env rather than shipping
// an operational host as an implicit credential/configuration default.
export const SURABAYA_BASE_URL = envValue('SURABAYA_BASE_URL', '');
export const SURABAYA_LIST_PATH = envValue('SURABAYA_LIST_PATH', '/cctvs');
export const SURABAYA_STATUS_PATH = envValue('SURABAYA_STATUS_PATH', '/api/cctv_statuses');
export const SURABAYA_START_PATH = envValue('SURABAYA_START_PATH', '/api/start_stream');
export const SURABAYA_STOP_PATH = envValue('SURABAYA_STOP_PATH', '/api/stop_stream');
export const SURABAYA_HLS_PATH = envValue('SURABAYA_HLS_PATH', '/hls');

export const BOJONEGORO_PAGE_URL = envValue(
  'BOJONEGORO_PAGE_URL',
  'https://data.bojonegorokab.go.id/dinas-perhubungan.html@detail=cctv'
);
export const BOJONEGORO_SESSION_PATH = envValue(
  'BOJONEGORO_SESSION_PATH',
  '/public/reff_dinhub/set_sessions_/sel_tahun/{year}'
);
export const BOJONEGORO_MAP_PATH = envValue(
  'BOJONEGORO_MAP_PATH',
  '/public/reff_dinhub/getCctv'
);
export const BOJONEGORO_STREAM_BASE = envValue(
  'BOJONEGORO_STREAM_BASE',
  'https://data.bojonegorokab.go.id/live/public'
);
export const BOJONEGORO_YEAR = envValue('BOJONEGORO_YEAR', '2026');
export const BOJONEGORO_USER_AGENT = envValue(
  'BOJONEGORO_USER_AGENT',
  'Mozilla/5.0 (compatible; LENSAMAS CCTV proxy/1.0)'
);

export const GRESIK_BASE_URL = envValue(
  'GRESIK_BASE_URL',
  'https://cctvkanjeng.gresikkab.go.id'
);
export const GRESIK_MARKERS_PATH = envValue(
  'GRESIK_MARKERS_PATH',
  '/api/v1/public/markers?mode=per_device&kind=cctv'
);
export const GRESIK_LOCATIONS_PATH = envValue(
  'GRESIK_LOCATIONS_PATH',
  '/api/v1/public/locations'
);
export const GRESIK_CCTV_PATH = envValue(
  'GRESIK_CCTV_PATH',
  '/api/v1/public/cctv'
);
export const GRESIK_HLS_PATH = envValue('GRESIK_HLS_PATH', '/hls');
export const GRESIK_USER_AGENT = envValue(
  'GRESIK_USER_AGENT',
  'Mozilla/5.0 (compatible; LENSAMAS CCTV proxy/1.0)'
);

export const TUBAN_BASE_URL = envValue('TUBAN_BASE_URL', 'https://cctv.tubankab.go.id');
export const TUBAN_GEOMETRIES_PATH = envValue('TUBAN_GEOMETRIES_PATH', '/api/geometries');
export const TUBAN_STREAM_TOKEN_PATH = envValue('TUBAN_STREAM_TOKEN_PATH', '/api/stream-token');
export const TUBAN_TOKEN_TTL_SECONDS = envValue('TUBAN_TOKEN_TTL_SECONDS', '120');
export const TUBAN_USER_AGENT = envValue(
  'TUBAN_USER_AGENT',
  'Mozilla/5.0 (compatible; LENSAMAS CCTV proxy/1.0)'
);

export const BANYUWANGI_BASE_URL = envValue('BANYUWANGI_BASE_URL', 'https://ayobanyuwangi.id');
export const BANYUWANGI_PAGE_PATH = envValue(
  'BANYUWANGI_PAGE_PATH',
  '/wp-json/wp/v2/pages/2844?_fields=id,modified,link,content.rendered'
);
export const BANYUWANGI_STREAM_BASE = envValue(
  'BANYUWANGI_STREAM_BASE',
  'https://live.banyuwangikab.go.id/hls'
);
export const BONDOWOSO_BASE_URL = envValue('BONDOWOSO_BASE_URL', 'https://dishub.bondowosokab.go.id');
export const BONDOWOSO_PAGE_PATH = envValue('BONDOWOSO_PAGE_PATH', '/cctv');
export const BONDOWOSO_STREAM_BASE = envValue(
  'BONDOWOSO_STREAM_BASE',
  'https://cctv.bondowosokab.go.id/cgi-bin/nph-zms'
);
export const BONDOWOSO_STREAM_USER = envValue('BONDOWOSO_STREAM_USER', '');
export const BONDOWOSO_STREAM_PASS = envValue('BONDOWOSO_STREAM_PASS', '');
export const BONDOWOSO_STREAM_SCALE = envValue('BONDOWOSO_STREAM_SCALE', '50');
export const BONDOWOSO_STREAM_MAX_FPS = envValue('BONDOWOSO_STREAM_MAX_FPS', '10');
export const SITUBONDO_BASE_URL = envValue('SITUBONDO_BASE_URL', 'https://cctv.situbondokab.go.id');
export const SITUBONDO_LIST_PATH = envValue('SITUBONDO_LIST_PATH', '/api/cctv');
export const SITUBONDO_MJPEG_BASE = envValue(
  'SITUBONDO_MJPEG_BASE',
  'https://cctvlive.situbondokab.go.id/zm/cgi-bin/nph-zms'
);
export const SITUBONDO_HLS_BASE = envValue(
  'SITUBONDO_HLS_BASE',
  'https://cctvstream.situbondokab.go.id'
);
export const SITUBONDO_ZM_USERNAME = envValue('SITUBONDO_ZM_USERNAME', '');
export const SITUBONDO_ZM_PASSWORD = envValue('SITUBONDO_ZM_PASSWORD', '');
export const SITUBONDO_ZM_SCALE = envValue('SITUBONDO_ZM_SCALE', '50');
export const SITUBONDO_ZM_MAX_FPS = envValue('SITUBONDO_ZM_MAX_FPS', '5');
export const PASURUAN_BASE_URL = envValue('PASURUAN_BASE_URL', 'https://dishub.pasuruankab.go.id');
export const PASURUAN_GEOJSON_PATH = envValue('PASURUAN_GEOJSON_PATH', '/maps/ajax/geojson');
export const PASURUAN_GEOJSON_MARKER = envValue('PASURUAN_GEOJSON_MARKER', '2_2');
export const PASURUAN_STREAM_BASE = envValue(
  'PASURUAN_STREAM_BASE',
  'https://dishub.pasuruankab.go.id:5444/LiveApp/streams'
);
export const REGIONAL_CCTV_USER_AGENT = envValue(
  'REGIONAL_CCTV_USER_AGENT',
  'Mozilla/5.0 (compatible; LENSAMAS CCTV proxy/1.0)'
);

export const KEDIRI_STREAM_BASE = envValue(
  'KEDIRI_STREAM_BASE',
  'https://pplterpadu.kedirikota.go.id:8888'
);

export const KEDIRI_CAMERAS = [
  ['Jetis', 'jetis', -7.8167, 112.0165],
  ['Tosaren', 'tosaren', -7.8276, 112.0122],
  ['Baruna', 'baruna', -7.8151, 112.0178],
  ['Alun-alun', 'alun_alun', -7.8169, 112.0117],
  ['Bandar Ngalim', 'bandar_ngalim', -7.8133, 112.0063],
  ['Mrican', 'mrican', -7.7995, 112.0342],
  ['Iskandar Muda', 'iskandar_muda', -7.8201, 112.0205],
  ['Muning', 'muning', -7.8225, 112.0096],
  ['Semampir', 'semampir', -7.8072, 112.0159],
  ['Nabatiasa', 'nabatiasa', -7.8138, 112.0244],
  ['Dandangan', 'dandangan', -7.8162, 112.0018],
  ['Water Torn', 'water_torn', -7.8095, 112.008],
  ['Tamanan', 'tamanan', -7.832, 112.0107],
  ['A Yani Utara', 'a_yani_utara', -7.8188, 112.007],
  ['Kawi', 'kawi', -7.8257, 112.016],
  ['Sukorame', 'sukorame', -7.8053, 112.027],
  ['A Yani Selatan', 'a_yani_selatan', -7.8248, 112.0074],
].map(([name, code, latitude, longitude]) => ({
  slug: `kediri-${code}`,
  name: `CCTV ${name}`,
  location: 'Kota Kediri',
  latitude,
  longitude,
  status: 'online',
  source: 'kediri',
  protocol: 'hls',
  sourceCode: code,
  streamUrl: `/api/hls-proxy?${new URLSearchParams({
    source: 'kediri',
    mode: 'hls',
    camera: String(code),
    asset: 'index.m3u8',
  }).toString()}`,
}));