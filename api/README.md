# CCTV API layout

All regional CCTV implementation modules live in `api/_lib/`.

- `api/_lib/*`: parsing, caching, TLS/session handling, normalization, and stream proxy logic.
- `api/*.ts`: thin Vercel entrypoints and compatibility exports only.
- `api/_lib/hls-router.ts`: shared regional HLS/MJPEG dispatcher used by the newer sources.

Keep public route names backward-compatible (`/api/malang`, `/api/sarangan` and `/api/hls-proxy`, and so on). Do not put upstream credentials, session values, or arbitrary upstream URLs in metadata responses or request logs.

The root `api/*.ts` files are intentionally not imported by the client: Vercel discovers them as function entrypoints. Named exports retained by the Malang, Mojokerto, Villabs, and Trenggalek facades are compatibility exports, not dead runtime code; do not delete them without a route/version migration.

## Dev and Vercel parity

The Vite middleware in `vite.config.ts` calls the same `_lib` handlers as the Vercel entrypoints. A stream URL that works through `http://localhost:5173` therefore exercises the same parser, proxy, timeout, and validation path used by `/api` on Vercel. Do not add browser-only or development-only stream behavior in a regional handler.

`npm run build` runs the API function-budget guard before the Vite build. The current project intentionally has 12 direct Vercel functions; future regional handlers must be dispatched through the existing entrypoint and live under `_lib`.

## Error handling policy (why the Vercel error rate stays low)

Most 5xx used to come from third parties, not from Lensamas: government CCTV
endpoints time out, answer 404, or refuse access. A Vercel error-rate metric
counts those as server errors, so the proxy now separates "we failed" from
"the content is not there".

1. **Metadata never returns 5xx.** Every source keeps an in-memory list cache
   seeded from `api/_lib/snapshots.json` (refresh with
   `npm run refresh:snapshots`). A cold function answers `200` from the snapshot
   while it refreshes in the background, and an upstream failure keeps serving
   the last known good list with `X-Lensamas-Data: stale`. If the upstream is
   still failing 45 s later, `api/_lib/regional-hls.ts` puts the source in a
   cooldown and answers `200` from the snapshot without touching the upstream
   again, with a short `s-maxage` so the Vercel CDN absorbs the repeat traffic.
2. **Content that does not exist returns 404, not 502.** Upstream `404/410/451`
   means the camera/asset is absent; upstream `401/403` means access was refused.
   Both are relayed to the browser as `404` (with `X-Lensamas-Stream:
   unavailable` and a 30 s CDN cache) instead of a gateway error. Only genuine
   proxy failures — timeout, socket, TLS, upstream 5xx — stay `502`, because
   that is the only case where Lensamas itself is at fault.
3. **One failure stops the hammering.** `api/_lib/stream-circuit.ts` records
   each failure per source+camera. `unavailable` (absent) cools down 60 s and
   marks the camera `offline` for 30 minutes; `unreachable` (timeout) cools down
   15 s and marks it for 5 minutes; `forbidden` cools down 20 s and never marks
   it offline because a session/cookie usually recovers. Repeat requests are
   answered from memory, so a dead camera costs one upstream hit per window
   instead of one per retry.
4. **Dead cameras are not offered for playback.** The circuit result is written
   back into the list response, so the client sees `status: "offline"` and does
   not send a stream request at all.
5. **The client gives up quickly.** `src/HlsPlayer.tsx` stops immediately on
   404/410/451, caps restarts at 4, and backs off exponentially instead of
   retrying every 300 ms. Surabaya's "manifest not ready" poll dropped from 10
   attempts to 4 and aborts on any 4xx.

A residual, unavoidable 5xx class remains: a source whose upstream neither
answers nor closes the connection within the timeout (currently seen on
Pasuruan) still produces a real `502`. That is the honest signal, and the circuit
keeps it from repeating.

## MJPEG operational requirements

Bondowoso and Situbondo use ZoneMinder `nph-zms` with server-side credentials:

- `BONDOWOSO_STREAM_USER` / `BONDOWOSO_STREAM_PASS`
- `SITUBONDO_ZM_USERNAME` / `SITUBONDO_ZM_PASSWORD`

The proxy forces `mode=mjpeg` (a `jpeg` request is only one frame), validates the fixed upstream host/path, bounds scale/FPS, and never sends credential query parameters to the browser. `MJPEG_MAX_DURATION_MS` defaults to `30000`; the client reconnects when a bounded stream ends. Set it to `0` only on a persistent Node/Go media proxy with an appropriate upstream/client timeout. Vercel Functions can stream for a finite duration, but an unbounded multipart connection is not a durable media server; use a persistent media gateway for 24/7 MJPEG availability.

## Logs and deployment

`api/_lib/request-log.ts` never logs request bodies, authorization headers, cookies, or raw query values. URLs, credentials, bearer values, and upstream URLs are redacted; successful media segment logs are sampled. `npm run dev` and `npm run preview` force request/provider logs off and only print actual runtime errors. Keep `REQUEST_LOG=0` on Vercel unless logs are explicitly needed; `REQUEST_LOG_VERBOSE=1` is only for temporary IP/host/user-agent diagnostics.

Playlist child URLs that require an upstream query use short-lived opaque IDs from `api/_lib/opaque-query.ts`; the actual query stays in server memory. Keep Fluid Compute/warm instances enabled for sources whose upstream session/query is instance-bound, or move those routes to a persistent media gateway.

The legacy Ponorogo, Madiun, and Mojokerto live paths are direct upstream WebSocket feeds. They are not HTTP Functions and cannot be transparently relayed by the current Vercel file-function setup; if the signed Ponorogo URL must never reach the browser, deploy a dedicated WebSocket/media gateway rather than weakening the no-token rule.

`vercel.json` pins the function region to `sin1` (Singapore), which is closer to the Indonesian upstream sources than the Vercel default `iad1`. Configure all variables above in the Vercel project, commit all new `_lib` files (including `snapshots.json`) before deploying, then run `vercel build` and `vercel deploy --prebuilt` (or the normal Git deployment). Never commit `.env` or rotate any token that has appeared in local logs/history.

`BONDOWOSO_STREAM_USER`/`BONDOWOSO_STREAM_PASS` and
`SITUBONDO_ZM_USERNAME`/`SITUBONDO_ZM_PASSWORD` must be present in the Vercel
project; otherwise those cameras report `streamConfigured: false` and the client
never requests them (the proxy still answers `503` if called directly). Pasuruan
resolves its per-camera stream asset lazily: one upstream POST when a camera is
opened, instead of one per camera on every list refresh.
