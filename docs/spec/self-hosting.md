# Self-hosting

Lawh is a repository people clone. Each copy runs in its owner's Cloudflare account, with its own hosts, owner, data and keys. Copies don't know about each other, and nothing reports back: no telemetry, no update server, no shared service.

## Install

Needs Node, pnpm, a Cloudflare account on Workers Paid, and no domain.

```
git clone https://github.com/Hamza-Labs-Core/lawh && cd lawh
pnpm install
pnpm lawh init
```

`lawh init` uses the owner's own Wrangler sign-in and can be run again safely:

1. Asks for the instance name (en and ar) and hosts: `workers.dev` (default) or the owner's domain.
2. Shows everything it will create, with the cost notes, and waits for a yes.
3. Creates D1, R2 and the queue, and generates the secrets on that machine.
4. Applies migrations and deploys both Workers with the `instance` switch off.
5. Creates the first project, turns the switch on after a yes, and runs `lawh owner setup`.

## What each copy chooses

| Setting | Default | Where |
|---|---|---|
| Hosts (app and content) | Two `workers.dev` hosts | `lawh.config.json` |
| Instance name, accent color, icon | Lawh's | `lawh.config.json` |
| Default language and theme | English, dark | `lawh.config.json` |
| Secrets backend | Secrets Store; Worker secrets if the account has no room or access | `lawh.config.json` |
| Version retention | Keep all | Settings screen |
| Webhooks, MCP | Off | Settings screen |

`lawh.config.json` and the generated Wrangler configs are gitignored, so a fork never publishes its owner's hosts or resource ids. The repository holds only `lawh.config.example.json`. It has no account id, host, product name or login from anyone's instance, and a CI check enforces that.

**Hosts.** `workers.dev` is on the Public Suffix List, so two Workers of one account are same-site, as two subdomains of one domain are. The sandbox doesn't rely on the sites being different (security.md section 2). Passkeys belong to the app host: moving to another host needs `lawh owner setup` again.

## Upgrades

`git pull && pnpm install && pnpm lawh upgrade`. It lists the pending migrations, takes a D1 export, applies them, deploys and checks both hosts. Migrations only add or backfill, so the previous release still works on the new schema; `lawh rollback` redeploys it. Breaking API changes get a new version (`/v2`), and releases follow semantic versioning with a changelog.

## Removal

`lawh destroy` offers an export, asks for the instance name, then deletes only the resources this copy created.

## Forks

CI runs without any secret, so a fork's checks pass as they are. Deploying is always the owner's own command or workflow. `SECURITY.md` gives a private way to report a problem, and `CONTRIBUTING.md` the local setup: `pnpm dev` runs both Workers with local D1 and R2 and no Cloudflare account.

## Tests

`init`, `upgrade`, `rollback` and `destroy` run against a mock Cloudflare API: a clean run, a run stopped at each step and started again, and a run beside resources that aren't Lawh's (never touched). Every release migrates a copy of the previous release's data.
