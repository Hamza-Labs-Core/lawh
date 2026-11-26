#!/usr/bin/env bash
# Lawh (لوح) no-clone installer & updater.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Hamza-Labs-Core/lawh/main/install.sh | bash
# Optional env vars:
#   LAWH_HOME       Install directory (default: $HOME/.lawh)
#   LAWH_BIN_DIR    Bin directory for `lawh` wrapper (default: $HOME/.local/bin)
#   LAWH_REPO       GitHub repository (default: Hamza-Labs-Core/lawh)
#   LAWH_VERSION    Release tag or "latest" (default: latest)
#   LAWH_TARBALL_URL Direct tarball URL (https://, http://, or file://)
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

# 2) Resolve release tag & tarball URL
TAG="$LAWH_VERSION"
TARBALL_URL="$LAWH_TARBALL_URL"

if [ -z "$TARBALL_URL" ]; then
  if [ "$TAG" = "latest" ]; then
    say "Checking latest Lawh release on ${LAWH_REPO}..."
    RELEASE_JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: lawh-installer" "${LAWH_API_URL%/}/repos/${LAWH_REPO}/releases/latest")" \
      || die "Failed to query latest release for ${LAWH_REPO}."
    TAG="$(printf '%s' "$RELEASE_JSON" | node -e '
      const fs = require("node:fs");
      const data = JSON.parse(fs.readFileSync(0, "utf8"));
      if (typeof data.tag_name !== "string" || !data.tag_name) process.exit(1);
      process.stdout.write(data.tag_name);
    ')" || die "Could not determine latest release tag."
  fi
  if ! printf '%s' "$TAG" | grep -Eq '^v?[0-9A-Za-z._-]+$'; then
    die "Invalid release tag: ${TAG}"
  fi
  TARBALL_URL="${LAWH_ARCHIVE_BASE%/}/${LAWH_REPO}/archive/refs/tags/${TAG}.tar.gz"
fi

# 3) Prepare directories and atomic staging
mkdir -p "$LAWH_HOME" "$LAWH_BIN_DIR"
chmod 700 "$LAWH_HOME"

STAGING="$(mktemp -d "$LAWH_HOME/.staging.XXXXXX")"
PREV_DIR=""
cleanup() {
  if [ -n "$PREV_DIR" ] && [ -d "$PREV_DIR" ] && [ ! -d "$LAWH_HOME/app" ]; then
    mv "$PREV_DIR" "$LAWH_HOME/app" || true
  fi
  rm -rf "$STAGING"
}
trap cleanup EXIT

say "Downloading Lawh (${TAG})..."
ARCHIVE="$STAGING/release.tar.gz"
case "$TARBALL_URL" in
  file://*)
    LOCAL_ARCHIVE="${TARBALL_URL#file://}"
    [ -f "$LOCAL_ARCHIVE" ] || die "Tarball not found: ${LOCAL_ARCHIVE}"
    cp "$LOCAL_ARCHIVE" "$ARCHIVE"
    ;;
  https://*|http://*)
    curl -fsSL -H "User-Agent: lawh-installer" "$TARBALL_URL" -o "$ARCHIVE" \
      || die "Failed to download ${TARBALL_URL}"
    ;;
  *)
    die "Unsupported LAWH_TARBALL_URL scheme (expected https://, http://, or file://)."
    ;;
esac

mkdir -p "$STAGING/app"
tar -xzf "$ARCHIVE" -C "$STAGING/app" --strip-components=1 \
  || die "Failed to extract Lawh release archive."

[ -f "$STAGING/app/package.json" ] && [ -f "$STAGING/app/scripts/lawh.mjs" ] \
  || die "Downloaded archive does not look like a valid Lawh release."

if [ "$LAWH_SKIP_INSTALL_DEPS" != "1" ]; then
  say "Installing dependencies..."
  (cd "$STAGING/app" && pnpm install --frozen-lockfile)
fi

# 4) Preserve existing instance configuration and local Wrangler state across updates
HAD_CONFIG=0
if [ -d "$LAWH_HOME/app" ]; then
  for f in lawh.config.json wrangler.app.jsonc wrangler.content.jsonc; do
    if [ -f "$LAWH_HOME/app/$f" ]; then
      cp -p "$LAWH_HOME/app/$f" "$STAGING/app/$f"
      [ "$f" = "lawh.config.json" ] && HAD_CONFIG=1
    fi
  done
  if [ -d "$LAWH_HOME/app/.wrangler" ]; then
    cp -Rp "$LAWH_HOME/app/.wrangler" "$STAGING/app/.wrangler"
  fi
fi

# 5) Atomically swap staged release into $LAWH_HOME/app
if [ -d "$LAWH_HOME/app" ]; then
  PREV_DIR="$LAWH_HOME/.previous.$$"
  rm -rf "$PREV_DIR"
  mv "$LAWH_HOME/app" "$PREV_DIR"
fi
mv "$STAGING/app" "$LAWH_HOME/app"
if [ -n "$PREV_DIR" ] && [ -d "$PREV_DIR" ]; then
  rm -rf "$PREV_DIR"
  PREV_DIR=""
fi

INSTALLED_VERSION="$(node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(process.argv[2] !== "latest" ? process.argv[2] : ("v" + pkg.version));
' "$LAWH_HOME/app/package.json" "$TAG")"
printf '%s\n' "$INSTALLED_VERSION" > "$LAWH_HOME/version.tmp.$$"
mv "$LAWH_HOME/version.tmp.$$" "$LAWH_HOME/version"

# 6) Install `lawh` wrapper script atomically into $LAWH_BIN_DIR
WRAPPER_TMP="$LAWH_BIN_DIR/.lawh.tmp.$$"
node -e '
  const fs = require("node:fs");
  const [tmpPath, homeDir] = process.argv.slice(1);
  const quoted = "'"'"'" + homeDir.replaceAll("'"'"'", "'"'"'\\'"'"''"'"'") + "'"'"'";
  const script = [
    "#!/usr/bin/env sh",
    "set -eu",
    "if [ -z \"${LAWH_HOME:-}\" ]; then",
    `  LAWH_HOME=${quoted}`,
    "fi",
    "export LAWH_HOME",
    "export LAWH_MANAGED_INSTALL=1",
    "exec node \"$LAWH_HOME/app/scripts/lawh.mjs\" \"$@\"",
    "",
  ].join("\n");
  fs.writeFileSync(tmpPath, script, { mode: 0o755 });
' "$WRAPPER_TMP" "$LAWH_HOME"
chmod 755 "$WRAPPER_TMP"
mv "$WRAPPER_TMP" "$LAWH_BIN_DIR/lawh"

say ""
say "Installed Lawh ${INSTALLED_VERSION} in ${LAWH_HOME}/app"
say "Command installed at ${LAWH_BIN_DIR}/lawh"

case ":${PATH:-}:" in
  *":$LAWH_BIN_DIR:"*) ;;
  *)
    say ""
    say "Add ${LAWH_BIN_DIR} to your PATH to run 'lawh' from any shell:"
    say "  export PATH=\"${LAWH_BIN_DIR}:\$PATH\""
    ;;
esac

say ""
if [ "$HAD_CONFIG" = "1" ]; then
  say "Existing instance config preserved. Run:"
  say "  lawh upgrade"
  say "to apply any new D1 migrations and redeploy your Cloudflare Workers."
else
  say "Next step — deploy your private Lawh copy to Cloudflare:"
  say "  lawh init"
fi
