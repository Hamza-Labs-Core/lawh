#!/usr/bin/env bash
# Lawh (لوح) no-clone installer & updater.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Hamza-Labs-Core/lawh/main/install.sh | bash
# Optional env vars:
#   LAWH_HOME        Install directory (default: $HOME/.lawh)
#   LAWH_BIN_DIR     Bin directory for `lawh` wrapper (default: $HOME/.local/bin)
#   LAWH_REPO        GitHub repository owner/name (default: Hamza-Labs-Core/lawh)
#   LAWH_VERSION     Release tag or "latest" (default: latest)
#   LAWH_TARBALL_URL Direct tarball URL (https://, file://, or http://localhost|127.0.0.1)
set -euo pipefail

LAWH_HOME="${LAWH_HOME:-$HOME/.lawh}"
LAWH_BIN_DIR="${LAWH_BIN_DIR:-$HOME/.local/bin}"
LAWH_REPO="${LAWH_REPO:-Hamza-Labs-Core/lawh}"
LAWH_VERSION="${LAWH_VERSION:-latest}"
LAWH_API_URL="${LAWH_API_URL:-https://api.github.com}"
LAWH_ARCHIVE_BASE="${LAWH_ARCHIVE_BASE:-https://github.com}"
LAWH_TARBALL_URL="${LAWH_TARBALL_URL:-}"
LAWH_SKIP_INSTALL_DEPS="${LAWH_SKIP_INSTALL_DEPS:-0}"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# 1) Pre-flight checks
command -v node >/dev/null 2>&1 || die "Node.js >= 22.12.0 is required. Install Node.js first: https://nodejs.org"
if ! node -e 'const [maj, min] = process.versions.node.split(".").map(Number); if (maj < 22 || (maj === 22 && min < 12)) process.exit(1);'; then
  die "Node.js >= 22.12.0 is required (found $(node -v))."
fi
command -v tar >/dev/null 2>&1 || die "tar is required."
command -v python3 >/dev/null 2>&1 || die "python3 is required for safe install locking."

# Normalize install paths to canonical absolute paths so relative paths work from any directory.
LAWH_HOME="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' -- "$LAWH_HOME")"
LAWH_BIN_DIR="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' -- "$LAWH_BIN_DIR")"

# Validate repo, tag, and URL overrides strictly (single string, no newlines, no option injection, HTTPS for non-loopback).
validate_url() {
  local raw="$1"
  local label="$2"
  local allow_file="$3"
  node -e '
    const [raw, label, allowFile] = process.argv.slice(1);
    if (!raw || /[\r\n\0]/.test(raw) || raw.startsWith("-")) {
      console.error(`Invalid ${label}.`);
      process.exit(1);
    }
    let u;
    try { u = new URL(raw); } catch { console.error(`Invalid ${label}.`); process.exit(1); }
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1" || u.hostname === "[::1]";
    if (u.protocol === "https:") process.exit(0);
    if (u.protocol === "http:" && loopback) process.exit(0);
    if (u.protocol === "file:" && allowFile === "1") process.exit(0);
    console.error(`${label} must use https:// (got ${u.protocol}).`);
    process.exit(1);
  ' -- "$raw" "$label" "$allow_file" || exit 1
}

is_loopback_http() {
  node -e '
    const u = new URL(process.argv[1]);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1" || u.hostname === "[::1]";
    process.exit(u.protocol === "http:" && loopback ? 0 : 1);
  ' -- "$1"
}

node -e '
  const repo = process.argv[1];
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) || repo.includes("..")) {
    console.error("Invalid LAWH_REPO (expected owner/repo).");
    process.exit(1);
  }
' -- "$LAWH_REPO" || exit 1

if [ "$LAWH_SKIP_INSTALL_DEPS" != "1" ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    if command -v corepack >/dev/null 2>&1; then
      say "Enabling pnpm via Corepack..."
      corepack enable >/dev/null 2>&1 || true
      corepack prepare pnpm@12.18.0 --activate >/dev/null 2>&1 || true
    fi
  fi
  command -v pnpm >/dev/null 2>&1 || die "pnpm is required. Enable it with 'corepack enable' or install via 'npm install -g pnpm'."
fi

need_curl=1
case "$LAWH_TARBALL_URL" in
  file://*) need_curl=0 ;;
esac
if [ "$need_curl" = "1" ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required."
fi

curl_fetch() {
  local url="$1"
  shift
  if is_loopback_http "$url"; then
    # Disallow redirects on loopback HTTP so a local test server cannot redirect to non-loopback HTTP.
    curl -fsS --max-redirs 0 --proto '=http' -H "User-Agent: lawh-installer" "$@" -- "$url"
  else
    curl -fsSL --proto '=https' --proto-redir '=https' -H "User-Agent: lawh-installer" "$@" -- "$url"
  fi
}

# 2) Resolve and validate release tag & tarball URL
TAG="$LAWH_VERSION"
TARBALL_URL="$LAWH_TARBALL_URL"

if [ -n "$TARBALL_URL" ]; then
  validate_url "$TARBALL_URL" "LAWH_TARBALL_URL" "1"
  if [ "$TAG" != "latest" ]; then
    node -e '
      const tag = process.argv[1];
      if (!/^v?[0-9A-Za-z._-]+$/.test(tag) || tag.includes("..")) {
        console.error(`Invalid release tag: ${tag}`);
        process.exit(1);
      }
    ' -- "$TAG" || exit 1
  fi
else
  validate_url "$LAWH_API_URL" "LAWH_API_URL" "0"
  validate_url "$LAWH_ARCHIVE_BASE" "LAWH_ARCHIVE_BASE" "0"
  if [ "$TAG" = "latest" ]; then
    say "Checking latest Lawh release on ${LAWH_REPO}..."
    API_ENDPOINT="${LAWH_API_URL%/}/repos/${LAWH_REPO}/releases/latest"
    RELEASE_JSON="$(curl_fetch "$API_ENDPOINT" -H "Accept: application/vnd.github+json")" \
      || die "Failed to query latest release for ${LAWH_REPO}."
    # Validate the exact raw JSON tag_name before command substitution can strip trailing newlines.
    TAG="$(printf '%s' "$RELEASE_JSON" | node -e '
      const fs = require("node:fs");
      const data = JSON.parse(fs.readFileSync(0, "utf8"));
      if (typeof data.tag_name !== "string" || !/^v?[0-9A-Za-z._-]+$/.test(data.tag_name) || data.tag_name.includes("..")) {
        console.error("Invalid release tag in release metadata.");
        process.exit(1);
      }
      process.stdout.write(data.tag_name);
    ')" || die "Could not determine a valid latest release tag."
  else
    node -e '
      const tag = process.argv[1];
      if (!/^v?[0-9A-Za-z._-]+$/.test(tag) || tag.includes("..")) {
        console.error(`Invalid release tag: ${tag}`);
        process.exit(1);
      }
    ' -- "$TAG" || exit 1
  fi
  TARBALL_URL="${LAWH_ARCHIVE_BASE%/}/${LAWH_REPO}/archive/refs/tags/${TAG}.tar.gz"
  validate_url "$TARBALL_URL" "release tarball URL" "0"
fi

# 3) Prepare home/bin directories and check wrapper collision BEFORE touching live state
mkdir -p "$LAWH_HOME" "$LAWH_BIN_DIR"
chmod 700 "$LAWH_HOME"
LAWH_HOME="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' -- "$LAWH_HOME")"
LAWH_BIN_DIR="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' -- "$LAWH_BIN_DIR")"

if [ -L "$LAWH_HOME/releases" ]; then
  die "Refusing to use symlinked releases directory: ${LAWH_HOME}/releases"
fi
mkdir -p "$LAWH_HOME/releases"

WRAPPER_PATH="$LAWH_BIN_DIR/lawh"
is_managed_wrapper() {
  local p="$1"
  [ -f "$p" ] && [ ! -L "$p" ] || return 1
  if grep -Fq "# managed-by-lawh-installer" "$p" 2>/dev/null; then
    return 0
  fi
  # Recognize round-1 managed wrappers during migration.
  if grep -Fq "export LAWH_MANAGED_INSTALL=1" "$p" 2>/dev/null && grep -Fq 'exec node "$LAWH_HOME/app/scripts/lawh.mjs" "$@"' "$p" 2>/dev/null; then
    return 0
  fi
  return 1
}

if [ -d "$WRAPPER_PATH" ]; then
  die "Refusing to install wrapper: ${WRAPPER_PATH} is an existing directory."
fi
if [ -e "$WRAPPER_PATH" ] || [ -L "$WRAPPER_PATH" ]; then
  if ! is_managed_wrapper "$WRAPPER_PATH"; then
    die "Refusing to overwrite unmanaged file at ${WRAPPER_PATH}. Remove it or choose another LAWH_BIN_DIR."
  fi
fi

# 4) Serialize concurrent installers via OS kernel fcntl.flock (persistent inode, never unlinked)
LOCK_HELPER_PID=""
LOCK_PIPE_DIR=""
STAGING=""
RELEASE_DIR=""
TMP_LINK=""
TMP_VERSION=""
TMP_META=""
TMP_INSTALLER=""
TMP_WRAPPER=""

HAD_LIVE_APP=0
PREV_IS_SYMLINK=0
PREV_SYMLINK_TARGET=""
PREV_REAL_DIR=""
PREV_MIGRATED_DIR=""
HAD_PREV_VERSION=0
HAD_PREV_META=0
HAD_PREV_INSTALLER=0
HAD_PREV_WRAPPER=0
PREV_VERSION_BAK=""
PREV_META_BAK=""
PREV_INSTALLER_BAK=""
PREV_WRAPPER_BAK=""
SWAPPED_APP=0
COMMITTED=0

cleanup() {
  if [ "$COMMITTED" != "1" ]; then
    # Roll back every publication step if anything failed after activation started.
    if [ "$SWAPPED_APP" = "1" ]; then
      if [ "$HAD_LIVE_APP" = "1" ]; then
        if [ "$PREV_IS_SYMLINK" = "1" ] && [ -n "$PREV_SYMLINK_TARGET" ]; then
          local restore_link
          restore_link="$(mktemp "$LAWH_HOME/.restore.XXXXXX")"
          rm -f "$restore_link"
          ln -s "$PREV_SYMLINK_TARGET" "$restore_link" 2>/dev/null || true
          node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' -- "$restore_link" "$LAWH_HOME/app" 2>/dev/null || true
        elif [ -n "$PREV_MIGRATED_DIR" ] && [ -d "$PREV_MIGRATED_DIR" ]; then
          rm -f "$LAWH_HOME/app" 2>/dev/null || true
          mv "$PREV_MIGRATED_DIR" "$LAWH_HOME/app" 2>/dev/null || true
        fi
      else
        rm -f "$LAWH_HOME/app" 2>/dev/null || true
      fi
      if [ "$HAD_PREV_VERSION" = "1" ] && [ -n "$PREV_VERSION_BAK" ] && [ -f "$PREV_VERSION_BAK" ]; then
        mv "$PREV_VERSION_BAK" "$LAWH_HOME/version" 2>/dev/null || true
      elif [ "$HAD_PREV_VERSION" = "0" ]; then
        rm -f "$LAWH_HOME/version" 2>/dev/null || true
      fi
      if [ "$HAD_PREV_META" = "1" ] && [ -n "$PREV_META_BAK" ] && [ -f "$PREV_META_BAK" ]; then
        mv "$PREV_META_BAK" "$LAWH_HOME/install.json" 2>/dev/null || true
      elif [ "$HAD_PREV_META" = "0" ]; then
        rm -f "$LAWH_HOME/install.json" 2>/dev/null || true
      fi
      if [ "$HAD_PREV_INSTALLER" = "1" ] && [ -n "$PREV_INSTALLER_BAK" ] && [ -f "$PREV_INSTALLER_BAK" ]; then
        mv "$PREV_INSTALLER_BAK" "$LAWH_HOME/install.sh" 2>/dev/null || true
      elif [ "$HAD_PREV_INSTALLER" = "0" ]; then
        rm -f "$LAWH_HOME/install.sh" 2>/dev/null || true
      fi
      if [ "$HAD_PREV_WRAPPER" = "1" ] && [ -n "$PREV_WRAPPER_BAK" ] && [ -f "$PREV_WRAPPER_BAK" ]; then
        mv "$PREV_WRAPPER_BAK" "$WRAPPER_PATH" 2>/dev/null || true
      elif [ "$HAD_PREV_WRAPPER" = "0" ]; then
        rm -f "$WRAPPER_PATH" 2>/dev/null || true
      fi
    else
      rm -f "$PREV_VERSION_BAK" "$PREV_META_BAK" "$PREV_INSTALLER_BAK" "$PREV_WRAPPER_BAK" 2>/dev/null || true
    fi
    if [ -n "$RELEASE_DIR" ] && [ -d "$RELEASE_DIR" ]; then
      rm -rf "$RELEASE_DIR" 2>/dev/null || true
    fi
  else
    # Committed cleanly: prune ONLY the pre-resolved real target strictly inside real $LAWH_HOME/releases/.
    if [ "$PREV_IS_SYMLINK" = "1" ] && [ -n "$PREV_REAL_DIR" ] && [ ! -L "$LAWH_HOME/releases" ]; then
      node -e '
        const fs = require("node:fs"), path = require("node:path");
        const [releasesDir, prevReal, currentRelease] = process.argv.slice(1);
        if (!fs.existsSync(prevReal) || !fs.statSync(prevReal).isDirectory()) process.exit(0);
        const base = fs.realpathSync.native(releasesDir) + path.sep;
        const target = fs.realpathSync.native(prevReal);
        const current = fs.realpathSync.native(currentRelease);
        if (target === current || !target.startsWith(base)) process.exit(0);
        fs.rmSync(target, { recursive: true, force: true });
      ' -- "$LAWH_HOME/releases" "$PREV_REAL_DIR" "$RELEASE_DIR" 2>/dev/null || true
    fi
    if [ -n "$PREV_MIGRATED_DIR" ] && [ -d "$PREV_MIGRATED_DIR" ]; then
      rm -rf "$PREV_MIGRATED_DIR" 2>/dev/null || true
    fi
    rm -f "$PREV_VERSION_BAK" "$PREV_META_BAK" "$PREV_INSTALLER_BAK" "$PREV_WRAPPER_BAK" 2>/dev/null || true
  fi
  rm -f "$TMP_LINK" "$TMP_VERSION" "$TMP_META" "$TMP_INSTALLER" "$TMP_WRAPPER" 2>/dev/null || true
  if [ -n "$STAGING" ]; then
    rm -rf "$STAGING" 2>/dev/null || true
  fi
  # Release install lock cleanly.
  exec 9>&- 2>/dev/null || true
  if [ -n "$LOCK_HELPER_PID" ]; then
    wait "$LOCK_HELPER_PID" 2>/dev/null || true
  fi
  if [ -n "$LOCK_PIPE_DIR" ]; then
    rm -rf "$LOCK_PIPE_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

acquire_install_lock() {
  local lock_path="$LAWH_HOME/.install.lock"
  if [ -L "$lock_path" ]; then
    die "Refusing to use symlinked lock path: ${lock_path}"
  fi
  if [ -d "$lock_path" ]; then
    die "Found a directory at ${lock_path} instead of a lock file; remove it if no install is running."
  fi
  LOCK_PIPE_DIR="$(mktemp -d "$LAWH_HOME/.lockpipe.XXXXXX")"
  local fifo="$LOCK_PIPE_DIR/hold"
  local status_fifo="$LOCK_PIPE_DIR/status"
  mkfifo "$fifo" "$status_fifo"
  python3 - "$lock_path" "$fifo" "$status_fifo" <<'PY' &
import fcntl, os, sys
lock_path, hold_fifo, status_fifo = sys.argv[1:4]
flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
try:
    fd = os.open(lock_path, flags, 0o600)
except OSError as exc:
    with open(status_fifo, "w") as s:
        s.write(f"ERR:{exc}\n")
    sys.exit(1)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    with open(status_fifo, "w") as s:
        s.write("BUSY\n")
    sys.exit(1)
with open(status_fifo, "w") as s:
    s.write("OK\n")
with open(hold_fifo, "r") as h:
    h.read()
PY
  LOCK_HELPER_PID=$!
  local lock_status=""
  read -r lock_status < "$status_fifo" || true
  if [ "$lock_status" = "BUSY" ]; then
    wait "$LOCK_HELPER_PID" 2>/dev/null || true
    LOCK_HELPER_PID=""
    die "Another Lawh install or update is already running."
  fi
  if [ "$lock_status" != "OK" ]; then
    wait "$LOCK_HELPER_PID" 2>/dev/null || true
    LOCK_HELPER_PID=""
    die "Could not acquire install lock (${lock_status#ERR:})."
  fi
  exec 9>"$fifo"
}
acquire_install_lock

STAGING="$(mktemp -d "$LAWH_HOME/.staging.XXXXXX")"

# 5) Download, inspect, extract, and validate archive entirely inside staging
say "Downloading Lawh (${TAG})..."
ARCHIVE="$STAGING/release.tar.gz"
case "$TARBALL_URL" in
  file://*)
    LOCAL_ARCHIVE="$(node -e 'process.stdout.write(require("node:url").fileURLToPath(process.argv[1]))' -- "$TARBALL_URL")"
    [ -f "$LOCAL_ARCHIVE" ] || die "Tarball not found: ${LOCAL_ARCHIVE}"
    cp "$LOCAL_ARCHIVE" "$ARCHIVE"
    ;;
  https://*|http://*)
    curl_fetch "$TARBALL_URL" -o "$ARCHIVE" \
      || die "Failed to download ${TARBALL_URL}"
    ;;
  *)
    die "Unsupported LAWH_TARBALL_URL scheme."
    ;;
esac

# Reject path traversal or absolute paths in archive entries before extracting.
TAR_LIST="$(tar -tzf "$ARCHIVE" 2>/dev/null)" || die "Failed to read Lawh release archive."
printf '%s\n' "$TAR_LIST" | node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) { console.error("Release archive is empty."); process.exit(1); }
  for (const entry of lines) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      console.error(`Unsafe path in release archive: ${entry}`);
      process.exit(1);
    }
  }
' || exit 1

mkdir -p "$STAGING/app"
tar -xzf "$ARCHIVE" -C "$STAGING/app" --strip-components=1 \
  || die "Failed to extract Lawh release archive."

# Validate required files and package metadata BEFORE touching the live installation.
[ -f "$STAGING/app/package.json" ] && [ ! -L "$STAGING/app/package.json" ] \
  || die "Downloaded archive is missing a valid package.json."
[ -f "$STAGING/app/scripts/lawh.mjs" ] && [ ! -L "$STAGING/app/scripts/lawh.mjs" ] \
  || die "Downloaded archive is missing scripts/lawh.mjs."

# Reject archives that try to smuggle reserved local-state paths.
for reserved in lawh.config.json wrangler.app.jsonc wrangler.content.jsonc .wrangler; do
  if [ -e "$STAGING/app/$reserved" ] || [ -L "$STAGING/app/$reserved" ]; then
    die "Release archive must not contain reserved local state path: ${reserved}"
  fi
done

INSTALLED_VERSION="$(node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!pkg || typeof pkg.version !== "string" || !/^[0-9A-Za-z._-]+$/.test(pkg.version)) {
    console.error("Invalid version in package.json.");
    process.exit(1);
  }
  const tag = process.argv[2];
  process.stdout.write(tag !== "latest" ? tag : ("v" + pkg.version));
' -- "$STAGING/app/package.json" "$TAG")" || die "Invalid package.json in release archive."

if [ "$LAWH_SKIP_INSTALL_DEPS" != "1" ]; then
  say "Installing dependencies..."
  (cd "$STAGING/app" && pnpm install --frozen-lockfile)
fi

# 6) Preserve existing instance configuration and local Wrangler state safely (no symlink following)
HAD_CONFIG=0
LIVE_APP_DIR=""
if [ -L "$LAWH_HOME/app" ]; then
  HAD_LIVE_APP=1
  PREV_IS_SYMLINK=1
  # Append sentinel 'x' so Bash command substitution preserves any trailing newlines in symlink targets.
  PREV_SYMLINK_TARGET="$(node -e 'process.stdout.write(require("node:fs").readlinkSync(process.argv[1]) + "x")' -- "$LAWH_HOME/app")"
  PREV_SYMLINK_TARGET="${PREV_SYMLINK_TARGET%x}"
  PREV_REAL_DIR="$(node -e '
    const fs = require("node:fs");
    try {
      const real = fs.realpathSync.native(process.argv[1]);
      if (fs.statSync(real).isDirectory()) process.stdout.write(real + "x");
    } catch {}
  ' -- "$LAWH_HOME/app")"
  PREV_REAL_DIR="${PREV_REAL_DIR%x}"
  if [ -d "$LAWH_HOME/app" ]; then
    LIVE_APP_DIR="$LAWH_HOME/app"
  fi
elif [ -d "$LAWH_HOME/app" ]; then
  HAD_LIVE_APP=1
  LIVE_APP_DIR="$LAWH_HOME/app"
fi

if [ -n "$LIVE_APP_DIR" ]; then
  for f in lawh.config.json wrangler.app.jsonc wrangler.content.jsonc; do
    if [ -L "$LIVE_APP_DIR/$f" ]; then
      die "Refusing to copy symlinked local state file: ${LIVE_APP_DIR}/${f}"
    fi
    if [ -f "$LIVE_APP_DIR/$f" ]; then
      cp -p "$LIVE_APP_DIR/$f" "$STAGING/app/$f"
      chmod 600 "$STAGING/app/$f"
      if [ "$f" = "lawh.config.json" ]; then
        HAD_CONFIG=1
      fi
    fi
  done
  if [ -L "$LIVE_APP_DIR/.wrangler" ]; then
    die "Refusing to copy symlinked .wrangler directory: ${LIVE_APP_DIR}/.wrangler"
  fi
  if [ -d "$LIVE_APP_DIR/.wrangler" ]; then
    cp -RPp "$LIVE_APP_DIR/.wrangler" "$STAGING/app/.wrangler"
    for secret_json in "$STAGING/app/.wrangler"/lawh-*.json; do
      if [ -f "$secret_json" ] && [ ! -L "$secret_json" ]; then
        chmod 600 "$secret_json"
      fi
    done
  fi
fi

# 7) Prepare ALL release artifacts in exclusive temp files BEFORE activating
RELEASE_DIR="$(mktemp -d "$LAWH_HOME/releases/rel.XXXXXX")"
rmdir "$RELEASE_DIR"
mv "$STAGING/app" "$RELEASE_DIR"

# Save a copy of install.sh for `lawh self-update` (prefer the newly staged install.sh, else this running script).
TMP_INSTALLER="$(mktemp "$LAWH_HOME/.install.sh.XXXXXX")"
if [ -f "$RELEASE_DIR/install.sh" ] && [ ! -L "$RELEASE_DIR/install.sh" ]; then
  cp "$RELEASE_DIR/install.sh" "$TMP_INSTALLER"
elif [ -f "${BASH_SOURCE[0]:-}" ]; then
  cp "${BASH_SOURCE[0]}" "$TMP_INSTALLER"
else
  cat > "$TMP_INSTALLER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
REPO="${LAWH_REPO:-Hamza-Labs-Core/lawh}"
curl -fsSL --proto '=https' --proto-redir '=https' -- "https://raw.githubusercontent.com/${REPO}/main/install.sh" | bash
EOF
fi
chmod 700 "$TMP_INSTALLER"

TMP_VERSION="$(mktemp "$LAWH_HOME/.version.XXXXXX")"
printf '%s\n' "$INSTALLED_VERSION" > "$TMP_VERSION"
chmod 600 "$TMP_VERSION"

TMP_META="$(mktemp "$LAWH_HOME/.install.json.XXXXXX")"
node -e '
  const fs = require("node:fs");
  const [out, home, binDir, repo, version] = process.argv.slice(1);
  fs.writeFileSync(out, JSON.stringify({ home, binDir, repo, version }, null, 2) + "\n", { mode: 0o600 });
' -- "$TMP_META" "$LAWH_HOME" "$LAWH_BIN_DIR" "$LAWH_REPO" "$INSTALLED_VERSION"
chmod 600 "$TMP_META"

TMP_WRAPPER="$(mktemp "$LAWH_BIN_DIR/.lawh.XXXXXX")"
node - "$TMP_WRAPPER" "$LAWH_HOME" "$LAWH_BIN_DIR" "$LAWH_REPO" <<'NODE'
const fs = require("node:fs");
const [tmpPath, homeDir, binDir, repo] = process.argv.slice(2);
const shQuote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const script = [
  "#!/usr/bin/env sh",
  "# managed-by-lawh-installer",
  "set -eu",
  `if [ -z "\${LAWH_HOME:-}" ]; then LAWH_HOME=${shQuote(homeDir)}; fi`,
  `if [ -z "\${LAWH_BIN_DIR:-}" ]; then LAWH_BIN_DIR=${shQuote(binDir)}; fi`,
  `if [ -z "\${LAWH_REPO:-}" ]; then LAWH_REPO=${shQuote(repo)}; fi`,
  "export LAWH_HOME LAWH_BIN_DIR LAWH_REPO",
  "export LAWH_MANAGED_INSTALL=1",
  'if [ "${1:-}" = "self-update" ] && [ "$#" -eq 1 ]; then',
  '  exec bash "$LAWH_HOME/install.sh"',
  "fi",
  'if [ "${1:-}" = "version" ] || [ "${1:-}" = "--version" ] || [ "${1:-}" = "-v" ]; then',
  '  if [ "$#" -eq 1 ] && ! grep -Fq "printVersion" "$LAWH_HOME/app/scripts/lawh.mjs" 2>/dev/null; then',
  '    exec node -e \'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log("lawh v"+p.version);\' -- "$LAWH_HOME/app/package.json"',
  "  fi",
  "fi",
  'if [ "${1:-}" = "login" ] && [ "$#" -eq 1 ] && ! grep -Fq "runWranglerLogin" "$LAWH_HOME/app/scripts/lawh.mjs" 2>/dev/null; then',
  '  export WRANGLER_SEND_METRICS=false',
  '  exec node "$LAWH_HOME/app/node_modules/wrangler/bin/wrangler.js" login',
  "fi",
  'exec node "$LAWH_HOME/app/scripts/lawh.mjs" "$@"',
  "",
].join("\n");
fs.writeFileSync(tmpPath, script, { mode: 0o755 });
NODE
chmod 755 "$TMP_WRAPPER"

# Backup existing metadata & wrapper individually for exact rollback on post-swap failure.
if [ -f "$LAWH_HOME/version" ]; then
  HAD_PREV_VERSION=1
  PREV_VERSION_BAK="$(mktemp "$LAWH_HOME/.version.bak.XXXXXX")"
  cp -p "$LAWH_HOME/version" "$PREV_VERSION_BAK"
fi
if [ -f "$LAWH_HOME/install.json" ]; then
  HAD_PREV_META=1
  PREV_META_BAK="$(mktemp "$LAWH_HOME/.install.json.bak.XXXXXX")"
  cp -p "$LAWH_HOME/install.json" "$PREV_META_BAK"
fi
if [ -f "$LAWH_HOME/install.sh" ]; then
  HAD_PREV_INSTALLER=1
  PREV_INSTALLER_BAK="$(mktemp "$LAWH_HOME/.install.sh.bak.XXXXXX")"
  cp -p "$LAWH_HOME/install.sh" "$PREV_INSTALLER_BAK"
fi
if [ -f "$WRAPPER_PATH" ]; then
  HAD_PREV_WRAPPER=1
  PREV_WRAPPER_BAK="$(mktemp "$LAWH_HOME/.wrapper.bak.XXXXXX")"
  cp -p "$WRAPPER_PATH" "$PREV_WRAPPER_BAK"
fi

# 8) Atomic activation: swap `$LAWH_HOME/app` symlink via POSIX rename(2), then publish metadata & wrapper
TMP_LINK="$(mktemp "$LAWH_HOME/.app.next.XXXXXX")"
rm -f "$TMP_LINK"
ln -s "$RELEASE_DIR" "$TMP_LINK"

if [ "$HAD_LIVE_APP" = "1" ] && [ "$PREV_IS_SYMLINK" = "0" ]; then
  PREV_MIGRATED_DIR="$(mktemp -d "$LAWH_HOME/releases/prev.XXXXXX")"
  rmdir "$PREV_MIGRATED_DIR"
  mv "$LAWH_HOME/app" "$PREV_MIGRATED_DIR"
fi
SWAPPED_APP=1
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' -- "$TMP_LINK" "$LAWH_HOME/app"
TMP_LINK=""

# Optional test hook (before metadata publication).
if [ "${LAWH_TEST_FAIL_AFTER_SWAP:-0}" = "1" ]; then
  die "Simulated failure after app swap."
fi

mv "$TMP_INSTALLER" "$LAWH_HOME/install.sh"
TMP_INSTALLER=""
mv "$TMP_META" "$LAWH_HOME/install.json"
TMP_META=""
mv "$TMP_VERSION" "$LAWH_HOME/version"
TMP_VERSION=""

# Optional test hook (after metadata publication, before wrapper publication).
if [ "${LAWH_TEST_FAIL_BEFORE_COMMIT:-0}" = "1" ]; then
  die "Simulated failure after metadata publication."
fi

mv "$TMP_WRAPPER" "$WRAPPER_PATH"
TMP_WRAPPER=""

COMMITTED=1

say ""
say "Installed Lawh ${INSTALLED_VERSION} in ${LAWH_HOME}/app"
say "Command installed at ${WRAPPER_PATH}"

NEED_PATH_EXPORT=0
case ":${PATH:-}:" in
  *":$LAWH_BIN_DIR:"*) ;;
  *)
    NEED_PATH_EXPORT=1
    say ""
    say "Add ${LAWH_BIN_DIR} to your PATH to run 'lawh' from any shell:"
    say "  export PATH=\"${LAWH_BIN_DIR}:\$PATH\""
    ;;
esac

say ""
if [ "$HAD_CONFIG" = "1" ]; then
  say "Existing instance config preserved. Run:"
  if [ "$NEED_PATH_EXPORT" = "1" ]; then
    say "  \"${WRAPPER_PATH}\" upgrade"
  else
    say "  lawh upgrade"
  fi
  say "to apply any new D1 migrations and redeploy your Cloudflare Workers."
else
  say "Next step — deploy your private Lawh copy to Cloudflare:"
  if [ "$NEED_PATH_EXPORT" = "1" ]; then
    say "  \"${WRAPPER_PATH}\" init"
  else
    say "  lawh init"
  fi
fi
