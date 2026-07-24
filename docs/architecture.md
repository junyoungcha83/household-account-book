# Architecture and migration boundary

- Static UI: root `index.html`, `assets/`, `data/`, `manifest.webmanifest`, `sw.js`.
- API and persistence: `worker/src/index.js`, `worker/wrangler.toml` (KV); deploy from `worker/`.

Keep public root paths and the Worker name stable. Internal refactoring requires compatibility entrypoints and Wrangler dry-run validation. Agent tools must enforce authorization and never bypass the account-book persistence service.
