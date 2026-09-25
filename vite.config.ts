import { defineConfig, loadEnv, type Plugin, type PluginOption, type ViteDevServer, type PreviewServer } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import villabsHandler from './api/_lib/villabs.js';
import saranganHandler from './api/_lib/sarangan-handler.js';
import saranganStreamHandler from './api/_lib/sarangan-stream.js';
import trenggalekHandler from './api/_lib/trenggalek.js';
import kediriHandler from './api/_lib/kediri.js';
import tulungagungHandler from './api/_lib/tulungagung.js';
import malangHandler from './api/_lib/malang.js';
import hlsProxyHandler from './api/_lib/hls-router.js';
import mojokertoHandler from './api/_lib/mojokerto.js';
import camerasHandler from './api/cameras.js';
import streamHandler from './api/stream/[slug].js';
import wifiHandler from './api/wifi.js';

function disableLocalRequestLogging(): void {
  process.env.REQUEST_LOG = '0';
  process.env.REQUEST_LOG_LEVEL = 'error';
  process.env.REQUEST_LOG_ALL = '0';
  process.env.REQUEST_LOG_VERBOSE = '0';
  process.env.REQUEST_LOG_STACK = '0';
}

function localApiPlugin(): Plugin {
  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void
  ): Promise<void> => {
    const rawUrl = req.url || '';
    let url: URL;
    try {
      url = new URL(rawUrl, 'http://localhost');
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: 'Request URL tidak valid.',
        requestId: res.getHeader('X-Request-Id') || null,
      }));
      return;
    }

    // Handler mandiri yang dipakai bersama versi serverless (Vercel).
    const dedicated: Record<string, { fn: (rq: IncomingMessage, rs: ServerResponse) => Promise<void>; label: string }> = {
      '/api/madiun': { fn: villabsHandler, label: 'Madiun' },
      '/api/villabs': { fn: villabsHandler, label: 'Madiun (fallback)' },
      '/api/sarangan': { fn: saranganHandler, label: 'Sarangan' },
      '/api/sarangan-stream': { fn: saranganStreamHandler, label: 'Sarangan-stream' },
      '/api/trenggalek': { fn: trenggalekHandler, label: 'Trenggalek' },
      '/api/kediri': { fn: kediriHandler, label: 'Kediri' },
      '/api/tulungagung': { fn: tulungagungHandler, label: 'Tulungagung' },
      '/api/malang': { fn: malangHandler, label: 'Malang' },
      '/api/hls-proxy': { fn: hlsProxyHandler, label: 'HLS proxy' },
      '/api/mojokerto': { fn: mojokertoHandler, label: 'Mojokerto' },
    };

    const dedicatedEntry = dedicated[url.pathname];
    if (dedicatedEntry) {
      try {
        await dedicatedEntry.fn(req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: `${dedicatedEntry.label} proxy error: ${(err as Error).message}`,
            requestId: res.getHeader('X-Request-Id') || null,
          }));
        }
      }
      return;
    }

    // Kompatibilitas cache lama: /api/malang-stream/<id>/<asset> -> /api/hls-proxy.
    const legacyMalang = url.pathname.match(/^\/api\/malang-stream\/([^/]+)\/(.+)$/);
    if (legacyMalang) {
      const compatUrl = new URL(req.url || '', 'http://localhost');
      compatUrl.pathname = '/api/hls-proxy';
      compatUrl.search = '';
      compatUrl.searchParams.set('source', 'malang');
      compatUrl.searchParams.set('streamId', legacyMalang[1]);
      compatUrl.searchParams.set('asset', legacyMalang[2]);
      req.url = `${compatUrl.pathname}${compatUrl.search}`;
      try {
        await hlsProxyHandler(req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: `HLS proxy error: ${(err as Error).message}`,
            requestId: res.getHeader('X-Request-Id') || null,
          }));
        }
      }
      return;
    }

    // `/api/cameras`, `/api/stream/<slug>`, dan `/api/wifi` memakai handler yang
    // sama persis dengan deployment Vercel agar logika tidak berbeda.
    if (url.pathname === '/api/cameras') {
      await camerasHandler(req, res);
      return;
    }
    if (url.pathname.startsWith('/api/stream/')) {
      await streamHandler(req, res);
      return;
    }
    if (url.pathname === '/api/wifi') {
      await wifiHandler(req, res);
      return;
    }

    return next();
  };

  return {
    name: 'local-api-proxy',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig(({ mode }) => {
  disableLocalRequestLogging();
  const env = loadEnv(mode, process.cwd(), '');
  const devProxy = env.DEV_API_PROXY || process.env.DEV_API_PROXY;

  const plugins: PluginOption[] = [react()];
  if (!devProxy) {
    plugins.push(localApiPlugin());
  }

  return {
    plugins,
    logLevel: 'error',
    server: devProxy
      ? {
          proxy: {
            '/api': {
              target: devProxy,
              changeOrigin: true,
            },
          },
        }
      : {},
    preview: devProxy
      ? {
          proxy: {
            '/api': {
              target: devProxy,
              changeOrigin: true,
            },
          },
        }
      : {},
  };
});
