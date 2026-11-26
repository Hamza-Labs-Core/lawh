# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report vulnerabilities privately through GitHub Security Advisories for this repository:
<https://github.com/Hamza-Labs-Core/lawh/security/advisories/new>

Include:
- A clear description of the issue and the affected component (app Worker, content Worker, sandbox, auth, webhooks, or CLI).
- Steps to reproduce locally (`pnpm dev` or a focused test case).
- Any suggested fix or mitigation, if you have one.

## Response timeline

- We aim to acknowledge private reports within 3 business days.
- We will coordinate a fix and release before public disclosure.

## Security architecture

Lawh's threat model, sandbox isolation, key handling, webhook verification, and test requirements are documented in [docs/spec/security.md](docs/spec/security.md).

Each self-hosted copy runs in its owner's own Cloudflare account with its own hosts, D1 database, R2 bucket, and secrets. Never commit `lawh.config.json`, generated `wrangler.*.jsonc` files, or secrets to any repository.
