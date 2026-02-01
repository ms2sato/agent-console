#!/bin/bash
# Setup gh CLI for Claude Code on the Web environment
# This script runs as a SessionStart hook to install gh CLI when running remotely.

# Only run in Claude Code on the Web environment
if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

# Skip if gh is already installed
if command -v gh &> /dev/null; then
  exit 0
fi

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  GH_ARCH="amd64" ;;
  aarch64) GH_ARCH="arm64" ;;
  *)
    echo "gh-setup: unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

GH_VERSION="2.67.0"
GH_TARBALL="gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz"
GH_URL="https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_TARBALL}"
INSTALL_DIR="$HOME/.local/bin"

mkdir -p "$INSTALL_DIR"

# Download and extract
cd /tmp
curl -fsSL "$GH_URL" -o "$GH_TARBALL"
tar xzf "$GH_TARBALL"
cp "gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh" "$INSTALL_DIR/gh"
chmod +x "$INSTALL_DIR/gh"

# Clean up
rm -rf "$GH_TARBALL" "gh_${GH_VERSION}_linux_${GH_ARCH}"

# Persist PATH via CLAUDE_ENV_FILE so gh is available throughout the session
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo "PATH=$INSTALL_DIR:\$PATH" >> "$CLAUDE_ENV_FILE"
fi

# GH_TOKEN is automatically recognized by gh CLI, no auth login needed

echo "gh-setup: gh CLI v${GH_VERSION} installed successfully"
