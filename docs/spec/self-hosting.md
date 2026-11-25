# Self-hosting

Lawh is a repository people clone. Each copy runs in its owner's Cloudflare account, with its own hosts, owner, people, data and keys. Copies don't know about each other, and nothing reports back: no telemetry, no update server, no shared service.

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
3. Creates D1, R2, the queue and the Durable Object class, and generates the secrets on that machine.
4. Applies migrations and deploys both Workers with the `instance` switch off.
5. Asks for the owner's display name, creates the first project, turns the switch on after a yes, and runs `lawh owner setup`.

To use it, the owner tells an agent to connect ([README](README.md) section 3). To share the copy, the owner turns on `teams` in Settings, makes a team and sends invite links ([teams.md](teams.md)). `lawh owner transfer <member>` hands the copy to someone else.

## What each copy chooses

| Setting | Default | Where |
|---|---|---|
| Hosts (app and content) | Two `workers.dev` hosts | `lawh.config.json` |
| Instance name, accent color, icon | Lawh's | `lawh.config.json` |
| Default language and theme | English, dark | `lawh.config.json` |
| Secrets backend | Secrets Store; Worker secrets if the account has no room or access | `lawh.config.json` |
| Version retention | Keep all | Settings screen |
| Teams, webhooks, live pings | Off | Settings screen |

`lawh.config.json` and the generated Wrangler configs are gitignored, so a fork never publishes its owner's hosts or resource ids. The repository holds only `lawh.config.example.json`. It has no account id, host, product name or login from anyone's instance, and a CI check enforces that.

**Hosts.** `workers.dev` is on the Public Suffix List, so two Workers of one account are same-site, as two subdomains of one domain are. The sandbox doesn't rely on the sites being different (security.md section 2). Passkeys belong to the app host: moving to another host needs `lawh owner setup` again, then a reset link for each member.

## Upgrades

`git pull && pnpm install && pnpm lawh upgrade`. It lists the pending migrations, records a D1 Time Travel bookmark and both Workers' current version ids, applies the migrations, deploys and checks both hosts. If a migration fails, it prints the one command that restores the bookmark. It doesn't use `wrangler d1 export`, which doesn't give a dump D1 can import again when the database has a virtual table such as the search index. Migrations only add or backfill, so the previous release still works on the new schema; `lawh rollback` puts each Worker back to its recorded version id, even if the upgrade stopped between the two. Breaking API changes get a new version (`/v2`), and releases follow semantic versioning with a changelog.

## Removal

`lawh destroy` offers Lawh's own export (a ZIP of JSON rows and page files, without the search index, which is rebuilt on import; import loads the rows before it adds the triggers, because old rows need not pass today's rules), asks for the instance name, then deletes only the resources this copy created.

Exports go to a folder outside the repository (`~/lawh-exports` by default). The command refuses a path inside the working tree.

## Forks

CI runs without any secret, so a fork's checks pass as they are. Deploying is always the owner's own command or workflow. `SECURITY.md` gives a private way to report a problem, and `CONTRIBUTING.md` the local setup: `pnpm dev` runs both Workers with local D1 and R2 and no Cloudflare account.

## Tests

`init`, `upgrade`, `rollback` and `destroy` run against a mock Cloudflare API that rejects what the real one rejects (including an export with a virtual table): a clean run, a run stopped at each step and started again, and a run beside resources that aren't Lawh's (never touched). Before a release, the author runs the whole cycle once against a throwaway Cloudflare account. Every release migrates a copy of the previous release's data.
