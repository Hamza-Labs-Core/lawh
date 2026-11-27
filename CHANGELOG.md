# Changelog

All notable changes to Lawh are documented in this file.

## [1.3.1] - 2026-11-27

### Improved
- **Code input auto-formatting on `/connect` and `/approve`:** Trims whitespace, forces uppercase letters, strips stray characters, caps at 8 letters, and automatically inserts the `-` dash after the 4th letter (without trapping Backspace).

## [1.3.0] - 2026-11-27

### Added
- **Self-updating agent CLI & skill (`lawh.mjs update`):** Any agent or teammate can run `node lawh.mjs update` to atomically download the latest `lawh.mjs` (and sibling `SKILL.md`, when installed as a skill) directly from their Lawh server.
- **Managed local skill installation & auto-refresh (`lawh skill install`, `lawh skill refresh`):** Owners can install the Lawh agent skill into local agent skill directories (`~/.agents/skills/lawh` and detected provider dirs, or `--dir <path>`) with `lawh skill install`; subsequent `lawh self-update` (or `install.sh`) runs automatically refresh every registered skill directory.

## [1.2.0] - 2026-11-26

### Added
- **Agent-proposed projects during `connect`:** Agents can pass `--project "<name>"` (and optional `--slug <slug>`) to `lawh.mjs connect` (`POST /v1/connect` optional `project` field). On `/connect`, the owner sees the proposed project pre-checked (editable or uncheckable) and approves creating the project and connecting the agent atomically in one click.
- **Owner-approved project creation for connected agents:** Connected owner agents can run `lawh.mjs project create "<name>" [--slug <slug>]` (`POST /v1/projects/requests` + `GET /v1/projects/requests/{id}`), printing an 8-letter code for `/connect`. Approving in the UI atomically creates the project and grants that agent's key access; refusing returns `403`.
- **Migration `0004_project_requests.sql`:** Added `project_requests` table with expiry/key indexes and owner-session DB triggers.

## [1.1.0] - 2026-11-26

### Added
- **Inline project creation on `/connect`:** Owners can create a new project directly inside the agent connection approval screen (with automatic URL address generation) and have it immediately selected for the agent, without leaving `/connect`.
- **Direct New project link on empty Library:** Owners signing in to a fresh instance with no projects yet see a direct link to create their first project.

### Changed
- **Single `Name` field everywhere:** Replaced separate English/Arabic name prompts and inputs with a single `Name` field in `lawh init` (instance name) and in the UI (`Settings → Projects` and `/connect`), auto-deriving the URL address from the name while keeping it editable. The UI itself remains bilingual (English / Arabic RTL).
- **Removed project creation from `lawh init`:** `lawh init` focuses solely on Cloudflare infrastructure, owner setup, and instance switch activation; projects are created in the web UI.

### Fixed
- **Mid-run Cloudflare OAuth token refresh:** `lawh` CLI commands now read the latest Wrangler OAuth token on each API request and automatically refresh and retry once on expired tokens or Cloudflare `Authentication error` (HTTP 401 / code 10000), preventing failures after `wrangler deploy` or pauses at interactive prompts.

## [1.0.2] - 2026-11-26

### Fixed
- **Bare custom domains in `lawh init`:** Accept bare hostnames (e.g. `lawh.example.com`) and optional trailing slashes in custom-domain prompts, automatically normalizing to `https://` while still rejecting `http://`, paths, queries, and fragments.
- **Secrets Store quota fallback (`maximum_stores_exceeded`):** Recognize Cloudflare's HTTP 400 `maximum_stores_exceeded` error in `isSecretsStoreUnavailable` so `lawh init` automatically falls back to Worker secrets when the account has already reached its Secrets Store limit.

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
