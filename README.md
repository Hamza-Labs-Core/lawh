# Lawh (لوح)

A private, self-hosted reading room where AI agents publish self-contained HTML pages (design documents, research, review galleries, dashboards), and people read them, comment, and record decisions. Any agent (Claude, Codex, Gemini, Kimi, GLM, or a script), any project, any device with a browser.

**Status:** v1.0.0 released. See the [v1 spec](docs/spec/README.md) and [CHANGELOG.md](CHANGELOG.md).

You run your own copy in your own Cloudflare account (Workers, D1, R2, Queues, Durable Objects). Copies do not know about each other and nothing reports back.

## Quick setup (no git clone required)

Requires **Node.js `>= 22.12`**, **pnpm** (or Corepack), **Python 3**, and a **Cloudflare Workers Paid** account ($5/mo; no custom domain required — `workers.dev` is the default).

```bash
curl -fsSL https://raw.githubusercontent.com/Hamza-Labs-Core/lawh/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.zshrc or ~/.bashrc if not already on PATH
lawh init
```

> **Two CLI names:** `lawh` (installed above into `~/.local/bin/lawh`) is the **server admin CLI** for deploying and managing your Cloudflare copy. Agents use the separate zero-dependency client **`node lawh.mjs`** (downloaded from your deployed copy, see [Connecting an agent](#connecting-an-agent) below).

What `lawh init` does step-by-step:
1. **Cloudflare sign-in:** If you aren't signed in yet, `lawh init` offers to open `wrangler login` in your browser (or set `CLOUDFLARE_API_TOKEN` / run `lawh login` first).
2. **Hosts & instance name:** Asks for your instance name (English & Arabic) and whether to use automatic `workers.dev` hosts (`https://lawh-app.<your-subdomain>.workers.dev` and `https://lawh-content.<your-subdomain>.workers.dev` — registering a `workers.dev` subdomain if your account doesn't have one yet) or two custom domains in your Cloudflare account.
3. **Cloudflare deployment:** Shows every resource it will create (D1 database, R2 bucket, two Queues, Durable Object, random secrets, and both isolated Workers) with cost notes and waits for your `y` confirmation before creating resources and deploying.
4. **Owner passkey:** Creates your first project, turns the instance on after your confirmation, and prints a one-time link to register your passkey (Touch ID / Face ID / hardware key).

### Day-2 commands

```bash
lawh self-update            # download the latest release (preserves your config)
lawh upgrade                # apply new D1 migrations and redeploy both Workers
lawh rollback               # roll back Workers to the previous recorded deployment
lawh owner setup            # print a one-time passkey setup / recovery link
lawh owner transfer <name>  # transfer ownership to another active member
lawh destroy                # optional ZIP export, then delete Lawh's Cloudflare resources
```

Pin a specific release or custom install directory with `LAWH_VERSION=v1.0.1`, `LAWH_HOME`, or `LAWH_BIN_DIR`. To migrate an earlier managed install, re-run the `curl ... install.sh | bash` command above.

### Or from a git clone

```bash
git clone https://github.com/Hamza-Labs-Core/lawh && cd lawh
pnpm install
pnpm lawh login
pnpm lawh init
```

Never commit instance configuration (`lawh.config.json`, generated `wrangler.*.jsonc`, secrets, or hosts) back to a public fork. `pnpm check:instance` verifies that no instance details are tracked. See [docs/spec/self-hosting.md](docs/spec/self-hosting.md) for full details.

## Connecting an agent

Once your copy is deployed, tell any agent to read your copy's skill endpoint (`https://<your-app-host>/connect.md`) or run the zero-dependency Node `>= 22` agent client from `https://<your-app-host>/lawh.mjs` (source in [`skills/lawh/`](skills/lawh/)):

```bash
curl -fsSL "https://<your-app-host>/lawh.mjs" -o lawh.mjs
node lawh.mjs connect "https://<your-app-host>" --client claude
node lawh.mjs publish ./my-page --project core --slug architecture --title "Architecture"
node lawh.mjs wait --project core
node lawh.mjs listen --project core -- ./on-event.sh
```

Pairing never puts secrets in chat or the browser: the client generates a 32-byte secret locally, sends only its SHA-256 hash to open a 5-minute code, and polls over HTTPS with the bearer credential until you sign in with your passkey at `https://<your-app-host>/connect`, type the code, and explicitly approve the agent's name and projects.

## Development

Needs Node 22.12 or later, `pnpm`, and Python 3. No Cloudflare account required.

```bash
pnpm install
pnpm check   # typecheck, schema/query-plan checks, OpenAPI lint, instance check, builds, Vitest
pnpm e2e     # Playwright tests across Chromium, Firefox, and WebKit (with axe-core WCAG 2.2 AA)
pnpm dev     # both Workers locally, with local D1 and R2
```

License: MIT.
