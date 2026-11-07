#!/bin/sh
# Download the Bun release zip listed in a checksum registry, refuse to go on
# unless it hashes to the SHA256 written in that registry, and install the
# binary into <out-dir>.
#
# Usage: fetch-bun.sh <registry-file> <out-dir>
#   registry-file  docker/bun-sha256.txt: "<version> <x64|aarch64> <sha256>"
#                  lines; the first data line names the version to install.
#   out-dir        receives `bun` (mode 0755) and `bun-version`.
#
# Used by docker/Dockerfile and docker/Dockerfile.systemd, in a throwaway build
# stage that has curl and unzip, so the final images need neither. The
# registry is the repository's own record of what Bun is allowed to be: a
# release asset that was replaced upstream fails here, and the checksum file
# published next to the release is deliberately not consulted (it is served
# from the same place as the zip).
#
# BUN_DOWNLOAD_BASE_URL (default: the oven-sh GitHub releases) and
# BUN_FETCH_ARCH (default: from `uname -m`) exist so the script can be tested
# against a local fixture without the network.
set -eu

registry="${1:?usage: fetch-bun.sh <registry-file> <out-dir>}"
out="${2:?usage: fetch-bun.sh <registry-file> <out-dir>}"
base_url="${BUN_DOWNLOAD_BASE_URL:-https://github.com/oven-sh/bun/releases/download}"

machine="${BUN_FETCH_ARCH:-$(uname -m)}"
case "$machine" in
  x86_64 | x64) arch=x64 ;;
  aarch64 | arm64) arch=aarch64 ;;
  *) echo "fetch-bun: unsupported architecture: $machine" >&2; exit 1 ;;
esac

version="$(awk '$1 !~ /^#/ && NF == 3 { print $1; exit }' "$registry")"
expected="$(awk -v v="$version" -v a="$arch" '$1 == v && $2 == a { print $3 }' "$registry")"
if [ -z "$version" ] || [ -z "$expected" ]; then
  echo "fetch-bun: $registry has no entry for bun '$version' on $arch" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -r "$work"' EXIT

curl -fsSL -o "$work/bun.zip" "$base_url/bun-v$version/bun-linux-$arch.zip"
echo "$expected  $work/bun.zip" | sha256sum -c - >&2 \
  || { echo "fetch-bun: SHA256 mismatch for bun $version ($arch); refusing to install" >&2; exit 1; }

unzip -q "$work/bun.zip" -d "$work/unzipped"
mkdir -p "$out"
install -m 0755 "$work/unzipped/bun-linux-$arch/bun" "$out/bun"
printf '%s\n' "$version" > "$out/bun-version"
