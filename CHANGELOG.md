# Changelog

All notable changes to Lawh are documented in this file.

## [1.0.1] - 2026-11-26

### Added
- **No-clone setup & update (`install.sh`):** One-command installer (`curl -fsSL https://raw.githubusercontent.com/Hamza-Labs-Core/lawh/main/install.sh | bash`) that unpacks tagged GitHub Releases into `~/.lawh/releases/`, activates `~/.lawh/app` atomically with rollback on failure, preserves `lawh.config.json`, generated Wrangler configs, and `.wrangler/`, and installs the `lawh` admin CLI wrapper into `~/.local/bin/lawh`.
- **Admin CLI commands (`scripts/lawh.mjs`):** Added `lawh login`, `lawh self-update`, and `lawh version`, automatic interactive `wrangler login` prompting during `lawh init`, Wrangler 4.164 `~/.wrangler` + token expiry alignment, and directly runnable managed recovery commands in `lawh upgrade`.

## [1.0.0] - 2026-11-26

Initial v1.0.0 release implementing the complete Lawh v1 specification (S1–S20):

### Core Platform & Security
- **Two-Worker Cloudflare architecture:** `lawh-app` (API, UI, D1 metadata, Queue producer/consumer, `LiveProject` Durable Object) and `lawh-content` (opaque-origin sandboxed page renderer backed by R2 and HMAC content tokens).
- **Strict sandbox & CSP:** Uploaded HTML pages run in `<iframe sandbox="allow-scripts">` with zero external network access, key/secret upload scanning (HTTP 422), and hostile-page browser tests across Chromium, Firefox, and WebKit.
- **Passkey authentication:** WebAuthn passkeys, sessions, cross-device code approval, owner setup, and ownership transfer.
- **Switches:** Server-enforced `instance` (off by default), `teams`, `webhooks`, and `live` switches.

### Reading Room, Decisions, Comments & Search
- **Pages & versions:** Three-step content-addressed publishing (`POST .../versions` → `PUT` blobs → `POST .../commit`), version history, soft delete with 30-day purge, version retention policy, and full ZIP export.
- **Full-size viewer:** Zoomable viewer for `<img>`, `<svg>`, and `<canvas>` elements with keyboard/touch navigation and focus restoration.
- **Decisions & multi-decider agreement:** Append-only decision history enforced by SQLite triggers, stale detection on wording changes, per-project `answersNeeded` agreement counts, answerer warnings, and decision progress views.
- **Comments:** Page- and section-anchored threads (surviving republishes), decider resolution, and agent replies.
- **Search:** FTS5 full-text search with consistent Arabic normalization and live autocomplete.
- **Bilingual & accessible UI:** Full English and Arabic RTL support with Arabic-Indic numerals, dark/light themes, PWA manifest/icons/shell-only service worker, and WCAG 2.2 AA verification (`axe-core`).

### Teams, People & Permissions
- **Teams & levels:** Team CRUD, project assignments, Viewer/Commenter/Decider/Manager levels, manager agent takeover, and exhaustive route-by-level permission matrix tests.
- **People lifecycle:** Single-use 3-day invite links, 1-day passkey reset links with post-reset agent key review, member removal, and CLI ownership transfer (`pnpm lawh owner transfer`).

### Agents, Events, Webhooks & Live Pings
- **Connect an agent:** Zero-copy browser code approval flow, server-hosted `/connect.md` skill, and zero-dependency Node `>= 22` CLI (`skills/lawh/lawh.mjs`).
- **Events & webhooks:** Ordered project event feed (`GET /v1/events`), signed HTTPS webhooks with host allowlists, Queue delivery with retries, and manual resend.
- **Live pings:** Per-project `LiveProject` Durable Object with HMAC WebSocket tickets broadcasting event sequence hints only, automatic 30s polling fallback when `live` is off, and `lawh wait` / `lawh listen` with kernel `fcntl.flock` cursor locking.

### Self-Hosting & Tooling
- **Self-hosting CLI:** `pnpm lawh init`, `upgrade`, `rollback`, `destroy`, `owner setup`, and `owner transfer`, plus fork-safe CI and `pnpm check:instance` to guard against committing instance config or secrets.
