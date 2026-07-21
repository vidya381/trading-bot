# Dashboard

React frontend, served as static assets and gated by Cloudflare Access
(spec sections 2 and 11). Not built yet — this is build step 10.

Placeholder only. When implemented it will have its own `package.json` and
build tooling, kept separate from the Worker's.

Two requirements to carry forward from the spec:

- One deployment per environment, each with its own URL and its own Access
  allow-list. Never one dashboard with a toggled policy (section 11.3).
- A persistent environment banner driven by the `ENVIRONMENT` variable baked
  in at deploy time, not a runtime toggle — e.g. a yellow
  "TESTNET, NOT REAL MONEY" banner (section 11.3).
