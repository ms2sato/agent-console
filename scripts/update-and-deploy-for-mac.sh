#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "==> Fetching latest main..."
git fetch origin
git checkout main
git pull origin main

echo "==> Installing dependencies..."
pnpm install

echo "==> Building..."
pnpm build

echo "==> Deploying..."
pnpm deploy:mac

echo "==> Done!"
