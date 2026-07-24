# Dashboard

React + Vite + TypeScript dashboard for the trading bot system (spec sections
2 and 11), styled with Tailwind v4. Its own toolchain, separate from the
Worker's, per the step 1 plan.

Built to date (this session): project scaffolding, the environment banner, the
status strip, and the bot list. It reads real data from the deployed backend by
polling `GET /api/bots` and `GET /api/alerts` every 5 seconds. Not built yet
(follow-up sessions): the bot detail view, the create-bot form, the alert feed
UI, the manual-adjustment form, and the kill-switch / liquidate controls.

## How it is served

There is **one deployment per environment** and no separate Pages project: the
built `dist/` is served as static assets from the SAME Worker that serves
`/api/*` (see `wrangler.jsonc` `env.<name>.assets`). `run_worker_first` routes
`/api/*` and `/health` to the Worker; everything else is served from `dist/`,
with `single-page-application` falling back to `index.html` so client-side
routes (e.g. `/bots/:id`) deep-link correctly.

## Authentication

There is **no login UI**. Cloudflare Access gates the whole origin before any
request reaches the app; the browser's existing Access session cookie
authenticates the same-origin `/api/*` fetches automatically (section 11).

## Environment banner

A persistent, unmissable banner shows which environment is running (amber
"TESTNET — NOT REAL MONEY" on testnet; a slim neutral bar on production). It is
driven by `VITE_ENVIRONMENT`, **baked in at build time** (`src/env.ts`), never
detected at runtime — so no runtime bug can make it wrong (section 11.3). Each
environment's build sets it explicitly (see the root `build:dashboard:*`
scripts).

## Local development

Quick visual look at the UI (Vite dev server, hot reload):

```bash
npm --prefix dashboard run dev      # or, from repo root: npm run dev:dashboard
```

This serves the app at http://localhost:5173 and proxies `/api` and `/health`
to a local `wrangler dev` on :8787. Note: `/api/*` is gated by Cloudflare Access
in deployment, so a purely local look shows the chrome (banner, strip, empty/
error states) rather than populated data — populated data needs the deployed,
Access-gated origin (or a local backend with a session and schema). The banner
shows "LOCAL DEVELOPMENT" in this mode.

## Build & deploy (from repo root)

The dashboard is built (with the right environment baked in) before each Worker
deploy:

```bash
npm run deploy:testnet       # builds dist with VITE_ENVIRONMENT=testnet, then wrangler deploy --env testnet
npm run deploy:production    # builds dist with VITE_ENVIRONMENT=production, then wrangler deploy --env production
```
