#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'mcp-browser-runtime: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: Prepare-McpBrowserRuntime.sh --source-root PATH --execute
EOF
  exit 2
}

source_root=""
execute=false
while (($#)); do
  case "$1" in
    --source-root) shift; source_root="${1:-}" ;;
    --execute) execute=true ;;
    *) usage ;;
  esac
  shift
done

$execute || fail 'Browser runtime preparation is intentionally gated. Re-run with --execute.'
[[ -d "$source_root" ]] || fail "Source root was not found: $source_root"
source_root="$(readlink -f -- "$source_root")"

for command in node npx apt dpkg-deb ldd mktemp readlink sha256sum; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command was not found: $command"
done

[[ -f /etc/os-release ]] || fail 'Linux distribution metadata is unavailable.'
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] ||
  fail "Remote Browser native bundle is currently qualified only for Ubuntu 24.04."
[[ "$(dpkg --print-architecture)" == "amd64" ]] ||
  fail 'Remote Browser native bundle is currently qualified only for amd64.'

packages=(
  libatk1.0-0t64
  libatk-bridge2.0-0t64
  libatspi2.0-0t64
  libxcomposite1
  libxdamage1
  libxfixes3
  libxrandr2
  libgbm1
  libasound2t64
  libxrender1
  libxi6
  fonts-dejavu-core
)

(
  cd "$source_root"
  PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
)

native_root="$source_root/runtime/native-libs"
tmp="$(mktemp -d)"
cleanup() {
  rm -rf -- "$tmp"
}
trap cleanup EXIT

(
  cd "$tmp"
  apt download "${packages[@]}"
)

rm -rf -- "$native_root"
mkdir -p "$native_root"
for deb in "$tmp"/*.deb; do
  dpkg-deb -x "$deb" "$native_root"
done

manifest="$native_root/packages.v1.tsv"
: > "$manifest"
for deb in "$tmp"/*.deb; do
  package_name="$(dpkg-deb -f "$deb" Package)"
  package_version="$(dpkg-deb -f "$deb" Version)"
  package_arch="$(dpkg-deb -f "$deb" Architecture)"
  package_sha="$(sha256sum "$deb" | cut -d' ' -f1)"
  printf '%s\t%s\t%s\t%s\n' \
    "$package_name" "$package_version" "$package_arch" "$package_sha" >> "$manifest"
done
sort -o "$manifest" "$manifest"

libdir="$native_root/usr/lib/x86_64-linux-gnu"
fontdir="$native_root/usr/share/fonts"
[[ -d "$libdir" ]] || fail 'Prepared native library directory is missing.'
[[ -d "$fontdir" ]] || fail 'Prepared Browser font directory is missing.'
find "$fontdir" -type f -name '*.ttf' -print -quit | grep -q . ||
  fail 'Prepared Browser font directory contains no TrueType fonts.'

shopt -s nullglob
headless_shells=(
  "$source_root"/node_modules/playwright-core/.local-browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell
)
ffmpeg_dirs=(
  "$source_root"/node_modules/playwright-core/.local-browsers/ffmpeg-*
)
shopt -u nullglob
(( ${#headless_shells[@]} == 1 )) ||
  fail "Expected exactly one Playwright chromium_headless_shell, found ${#headless_shells[@]}."
(( ${#ffmpeg_dirs[@]} == 1 )) ||
  fail "Expected exactly one Playwright ffmpeg runtime, found ${#ffmpeg_dirs[@]}."
headless_shell="${headless_shells[0]}"
[[ -x "$headless_shell" ]] || fail 'Prepared chromium_headless_shell is not executable.'

missing="$(
  LD_LIBRARY_PATH="$libdir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    ldd "$headless_shell" | grep 'not found' || true
)"
[[ -z "$missing" ]] || {
  printf '%s\n' "$missing" >&2
  fail 'Prepared Chromium still has unresolved native libraries.'
}

LD_LIBRARY_PATH="$libdir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  "$headless_shell" --version >/dev/null

fontconfig_file="$tmp/fonts.conf"
font_cache="$tmp/font-cache"
mkdir -p "$font_cache"
cat > "$fontconfig_file" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>$fontdir</dir>
  <cachedir>$font_cache</cachedir>
  <config></config>
</fontconfig>
EOF

(
  cd "$source_root"
  PLAYWRIGHT_BROWSERS_PATH=0 \
  LD_LIBRARY_PATH="$libdir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  FONTCONFIG_FILE="$fontconfig_file" \
    node --input-type=module - <<'NODE'
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent("<title>MCP V3 Browser Runtime</title><p>ready</p>");
if (await page.title() !== "MCP V3 Browser Runtime") {
  throw new Error("Browser runtime smoke returned an unexpected page title.");
}
await browser.close();
NODE
)

printf 'status=prepared\n'
printf 'nativeLibPath=%s\n' "$libdir"
printf 'nativeFontPath=%s\n' "$fontdir"
printf 'nativePackageManifest=%s\n' "$manifest"
printf 'headlessShell=%s\n' "$headless_shell"
