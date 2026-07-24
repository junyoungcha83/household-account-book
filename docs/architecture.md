# Architecture and migration boundary

- Static UI: root `index.html`, `assets/`, `data/`, `manifest.webmanifest`, `sw.js`.
- API and persistence: `api/src/index.js`, `api/wrangler.toml` (KV); deploy from `api/` (`cd api && npm run deploy`). The Worker `name` (`household-account-book-api`) and KV binding (`HOUSEHOLD`) are unchanged by the directory rename.

Keep public root paths and the Worker name stable. Internal refactoring requires compatibility entrypoints and Wrangler dry-run validation. Agent tools must enforce authorization and never bypass the account-book persistence service.
