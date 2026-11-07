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
# Two entries for the same version and architecture are refused outright: an
# ambiguous registry is not a registry, and a bogus first hash next to a genuine
# second one must never be able to pass.
expected="$(awk -v v="$version" -v a="$arch" '$1 == v && $2 == a { count++; hash = $3 } END { if (count > 1) exit 1; print hash }' "$registry")" \
  || { echo "fetch-bun: duplicate entry for bun '$version' on $arch in $registry" >&2; exit 1; }
if [ -z "$version" ] || [ -z "$expected" ]; then
  echo "fetch-bun: $registry has no entry for bun '$version' on $arch" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -r "$work"' EXIT

curl -fsSL -o "$work/bun.zip" "$base_url/bun-v$version/bun-linux-$arch.zip"

# GNU coreutils (the Debian/Ubuntu build stages) has sha256sum; macOS, where the
# tests may run, has shasum instead. Either way the digest is compared as a plain
# string against the registry value.
if command -v sha256sum > /dev/null 2>&1; then
  actual="$(sha256sum "$work/bun.zip" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$work/bun.zip" | awk '{ print $1 }')"
fi
if [ "$actual" != "$expected" ]; then
  echo "fetch-bun: SHA256 mismatch for bun $version ($arch): expected $expected, got $actual; refusing to install" >&2
  exit 1
fi

unzip -q "$work/bun.zip" -d "$work/unzipped"
mkdir -p "$out"
install -m 0755 "$work/unzipped/bun-linux-$arch/bun" "$out/bun"
printf '%s\n' "$version" > "$out/bun-version"
