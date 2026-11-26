# Contributing to Lawh

Thank you for contributing to Lawh.

## Local development

Lawh runs locally with local D1 and R2 and requires **no Cloudflare account**.

Prerequisites:
- Node.js 22.12+ (`.node-version` pins Node 24)
- pnpm (`corepack enable`)
- Python 3 (for schema, query-plan, migration, and instance-leak checks)

```bash
pnpm install
pnpm check   # typecheck, schema/query plans, OpenAPI lint, instance check, builds, unit tests
pnpm dev     # runs both lawh-app and lawh-content Workers with local D1 and R2
```

To sign in locally as the owner:

```bash
pnpm lawh owner setup --local
```

To run the full browser test suite across Chromium, Firefox, and WebKit:

```bash
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm e2e
```

## Forks and CI

CI (`.github/workflows/ci.yml`) runs with zero repository secrets, so every fork's checks pass out of the box. Deploying is always the owner's own command (`pnpm lawh init` / `pnpm lawh upgrade`) or personal workflow.

## Never commit instance configuration

`lawh.config.json`, `wrangler.app.jsonc`, `wrangler.content.jsonc`, `.dev.vars*`, and `.env*` are gitignored so a fork never publishes its owner's hosts, account IDs, or resource IDs. Keep only `lawh.config.example.json` in the repository with placeholder values; `pnpm check:instance` enforces this in CI.

## Pull requests

- Keep changes focused and covered by tests (`pnpm check` and, for UI/sandbox changes, `pnpm e2e`).
- Schema changes must keep `migrations/` and `docs/spec/schema.sql` identical (`pnpm check:schema`) and must never add, rename, or remove Durable Object classes.
- Never run tests against a deployed instance.
