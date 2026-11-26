"""Checks that no real instance details, resource IDs, or secrets are tracked in git.

Run: python3 scripts/check_no_instance.py [--root <dir>]
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys

FORBIDDEN_FILES = {
    "lawh.config.json",
    "wrangler.json",
    "wrangler.jsonc",
    "wrangler.toml",
    "wrangler.app.json",
    "wrangler.app.jsonc",
    "wrangler.app.toml",
    "wrangler.content.json",
    "wrangler.content.jsonc",
    "wrangler.content.toml",
    ".dev.vars",
    ".env",
}

REQUIRED_GITIGNORE = [
    "/lawh.config.json",
    "/wrangler.app.jsonc",
    "/wrangler.content.jsonc",
    ".dev.vars*",
    ".env",
]

HEX32 = re.compile(r"\b[0-9a-fA-F]{32}\b")
UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
REAL_WORKERS_DEV = re.compile(r"https?://[a-z0-9-]+\.(?!<)[a-z0-9-]+\.workers\.dev\b", re.IGNORECASE)
PRIVATE_KEY_HEADER = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")
ID_FIELD_RE = re.compile(
    r'"(?:account_id|accountId|database_id|store_id|queue_id)"\s*:\s*"([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"'
)
CI_SECRET_RE = re.compile(r"\$\{\{\s*secrets\.")


def list_files(root: pathlib.Path) -> list[str]:
    try:
        out = subprocess.check_output(
            ["git", "-C", str(root), "ls-files", "-z"],
            stderr=subprocess.DEVNULL,
        )
        return [p for p in out.decode("utf-8").split("\0") if p]
    except Exception:
        files: list[str] = []
        for p in root.rglob("*"):
            if p.is_file() and ".git" not in p.parts and "node_modules" not in p.parts:
                files.append(p.relative_to(root).as_posix())
        return sorted(files)


def check_repo(root: pathlib.Path) -> list[str]:
    bad: list[str] = []
    tracked = list_files(root)
    tracked_set = set(tracked)

    # 1) Generated instance config, .wrangler state/secrets, and local secret files must never be tracked.
    for rel in tracked:
        name = pathlib.PurePosixPath(rel).name
        if (
            rel in FORBIDDEN_FILES
            or rel.startswith(".wrangler/")
            or name.startswith(".dev.vars.")
            or name.startswith(".env.")
        ):
            bad.append(f"instance or secret file is tracked: {rel}")

    # 2) .gitignore must protect generated instance files.
    gitignore = root / ".gitignore"
    if not gitignore.is_file():
        bad.append(".gitignore is missing")
    else:
        lines = {line.strip() for line in gitignore.read_text(encoding="utf-8").splitlines()}
        for required in REQUIRED_GITIGNORE:
            if required not in lines:
                bad.append(f".gitignore is missing required entry: {required}")

    # 3) lawh.config.example.json must exist and contain only generic Lawh defaults (no real account/resource IDs, custom hosts, or org names).
    example_path = root / "lawh.config.example.json"
    if not example_path.is_file():
        bad.append("lawh.config.example.json is missing")
    else:
        try:
            example = json.loads(example_path.read_text(encoding="utf-8"))
        except Exception as err:
            bad.append(f"lawh.config.example.json is invalid JSON: {err}")
        else:
            inst_name = example.get("instance", {}).get("name", {})
            if inst_name.get("en") != "Lawh" or inst_name.get("ar") != "لوح":
                bad.append(f"lawh.config.example.json must keep default Lawh instance names (got {inst_name!r})")
            resources = example.get("resources", {})
            for label, val in [
                ("resources.accountId", resources.get("accountId", "")),
                ("resources.database.id", resources.get("database", {}).get("id", "")),
                ("resources.queue.id", resources.get("queue", {}).get("id", "")),
                ("resources.deadLetterQueue.id", resources.get("deadLetterQueue", {}).get("id", "")),
                ("resources.secretsStore.id", resources.get("secretsStore", {}).get("id", "")),
            ]:
                if val:
                    bad.append(f"lawh.config.example.json must leave {label} empty (got {val!r})")
            if resources.get("secretsStore", {}).get("secrets"):
                bad.append("lawh.config.example.json must leave resources.secretsStore.secrets empty")
            hosts = example.get("hosts", {})
            if hosts.get("mode") != "workers.dev":
                bad.append(f"lawh.config.example.json must keep hosts.mode='workers.dev' (got {hosts.get('mode')!r})")
            placeholder_host = re.compile(r"^https://[a-z0-9-]+\.<your-subdomain>\.workers\.dev$")
            for host_key in ("app", "content"):
                host_val = str(hosts.get(host_key, ""))
                if REAL_WORKERS_DEV.search(host_val) or not placeholder_host.fullmatch(host_val):
                    bad.append(f"lawh.config.example.json hosts.{host_key} must use a placeholder host (got {host_val!r})")
            raw_example = example_path.read_text(encoding="utf-8")
            if HEX32.search(raw_example) or UUID_RE.search(raw_example):
                bad.append("lawh.config.example.json contains a hex/UUID resource identifier")

    # 4) Fork-safe CI: .github/workflows/ci.yml must not require secrets.
    ci_path = root / ".github/workflows/ci.yml"
    if ci_path.is_file():
        if CI_SECRET_RE.search(ci_path.read_text(encoding="utf-8")):
            bad.append(".github/workflows/ci.yml references GitHub secrets (breaks fork CI)")

    # 5) Scan all tracked text files (including tests and YAML) for leaked Cloudflare resource IDs, real workers.dev hosts, or private keys.
    skip_suffixes = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff2", ".zip", ".pdf"}
    for rel in tracked:
        if rel in ("pnpm-lock.yaml",) or pathlib.PurePosixPath(rel).suffix.lower() in skip_suffixes:
            continue
        p = root / rel
        if not p.is_file():
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if not rel.startswith("test/") and ID_FIELD_RE.search(text):
            bad.append(f"{rel} contains a real Cloudflare resource ID")
        if REAL_WORKERS_DEV.search(text):
            bad.append(f"{rel} contains a real workers.dev host URL")
        if PRIVATE_KEY_HEADER.search(text):
            bad.append(f"{rel} contains a private key block")

    if "lawh.config.example.json" not in tracked_set and (root / ".git").exists():
        bad.append("lawh.config.example.json is not tracked by git")

    return bad


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=str(pathlib.Path(__file__).resolve().parent.parent))
    args = parser.parse_args()
    root = pathlib.Path(args.root).resolve()
    bad = check_repo(root)
    for item in bad:
        print("FAIL", item)
    if not bad:
        print("ok   no instance config, resource ids, real hosts, or CI secrets found")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
