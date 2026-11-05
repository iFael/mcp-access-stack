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
# Paths are absolute from here on; leave the caller's directory, which the
# service account may not be able to read (find then fails on exit).
cd /

for command in node npx apt dpkg-deb ldd mktemp readlink sha256sum curl tar install; do
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
[[ -n "$(find "$fontdir" -type f -name '*.ttf' -print -quit)" ]] ||
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

# Full static FFmpeg for GIF/H.264 previews. Use an immutable upstream build.
media_release='autobuild-2026-11-03-12-50'
media_asset='ffmpeg-N-128352-gec887b13a8-linux64-gpl.tar.xz'
media_url="https://github.com/BtbN/FFmpeg-Builds/releases/download/$media_release"
media_checksum_file="$tmp/ffmpeg-checksums.sha256"
media_archive="$tmp/$media_asset"
curl --fail --location --retry 2 --connect-timeout 20 --max-time 240 \
  --output "$media_checksum_file" "$media_url/checksums.sha256" ||
  fail 'Unable to download pinned FFmpeg checksum manifest.'
media_checksum_actual="$(sha256sum "$media_checksum_file" | cut -d' ' -f1)"
[[ "$media_checksum_actual" == 'a48ca149c424241395907ce66d0ec7337cf62ef6dc0ca58706a4249897bfebcb' ]] ||
  fail 'Pinned FFmpeg checksum manifest does not match its known digest.'
media_sha="$(awk -v name="$media_asset" '$2 == name || $2 == "*" name { print $1 }' "$media_checksum_file")"
[[ "$media_sha" =~ ^[a-f0-9]{64}$ ]] || fail 'FFmpeg archive checksum is missing or ambiguous.'
curl --fail --location --retry 2 --connect-timeout 20 --max-time 300 \
  --output "$media_archive" "$media_url/$media_asset" ||
  fail 'Unable to download pinned FFmpeg media archive.'
[[ "$(sha256sum "$media_archive" | cut -d' ' -f1)" == "$media_sha" ]] ||
  fail 'FFmpeg media archive checksum mismatch.'
media_entry="$(tar -tJf "$media_archive" | grep -E '^[^/]+/bin/ffmpeg$' || true)"
[[ -n "$media_entry" && "$media_entry" != *$'\n'* ]] ||
  fail 'Pinned FFmpeg archive must contain exactly one bin/ffmpeg.'
media_root="$source_root/runtime/media"
mkdir -p "$media_root"
tar -xJOf "$media_archive" "$media_entry" > "$tmp/ffmpeg"
install -m 0755 "$tmp/ffmpeg" "$media_root/ffmpeg"
media_license="${media_entry%/bin/ffmpeg}/LICENSE.txt"
tar -xJOf "$media_archive" "$media_license" > "$media_root/LICENSE.ffmpeg.txt" ||
  fail 'Pinned FFmpeg archive lacks the applicable GPL license.'
[[ -s "$media_root/LICENSE.ffmpeg.txt" ]] || fail 'FFmpeg GPL license is empty.'
media_encoders="$("$media_root/ffmpeg" -hide_banner -encoders 2>/dev/null)" ||
  fail 'Pinned FFmpeg failed to list video encoders.'
grep -Eq '^[[:space:]]*V[^[:space:]]*[[:space:]]+libx264[[:space:]]' <<<"$media_encoders" ||
  fail 'Pinned FFmpeg lacks libx264 encoder.'
grep -Eq '^[[:space:]]*V[^[:space:]]*[[:space:]]+gif[[:space:]]' <<<"$media_encoders" ||
  fail 'Pinned FFmpeg lacks GIF encoder.'
"$media_root/ffmpeg" -nostdin -hide_banner -loglevel error -f lavfi \
  -i 'testsrc2=s=160x90:r=10:d=0.5' -an -c:v libx264 -pix_fmt yuv420p \
  -y "$tmp/ffmpeg-probe.mp4" ||
  fail 'Pinned FFmpeg failed an actual H.264 encoding smoke test.'
[[ -s "$tmp/ffmpeg-probe.mp4" ]] || fail 'Pinned FFmpeg produced an empty test MP4.'
"$media_root/ffmpeg" -nostdin -hide_banner -loglevel error -f lavfi \
  -i 'testsrc2=s=160x90:r=10:d=0.5' -an -c:v gif \
  -y "$tmp/ffmpeg-probe.gif" ||
  fail 'Pinned FFmpeg failed an actual GIF encoding smoke test.'
[[ -s "$tmp/ffmpeg-probe.gif" ]] || fail 'Pinned FFmpeg produced an empty test GIF.'

printf 'status=prepared\n'
printf 'nativeLibPath=%s\n' "$libdir"
printf 'nativeFontPath=%s\n' "$fontdir"
printf 'nativePackageManifest=%s\n' "$manifest"
printf 'headlessShell=%s\n' "$headless_shell"
