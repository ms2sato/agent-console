#!/usr/bin/env node

/**
 * Workspace Link Check
 *
 * A stale `node_modules` (one that predates a `@agent-console/*` workspace
 * dependency being newly declared in some package's `package.json`) is
 * missing exactly one symlink. From inside, the resulting module-resolution
 * error names a module, not a manifest, and is indistinguishable from a
 * genuine missing dependency. `bun install` fixes it in one command, but
 * only once you know that's the cause.
 *
 * This check makes the diagnosis mechanical: for every `@agent-console/*`
 * entry in `dependencies` / `devDependencies` of the repo root and each
 * `packages/*` workspace member, require the corresponding
 * `node_modules/@agent-console/<name>` entry to exist as a symlink. Bun
 * always materializes a workspace dependency as a symlink, never a real
 * directory (measured directly against this repo's own `bun install`,
 * 2026-10-10) — so a present-but-not-a-symlink entry is reported exactly
 * like an absent one, on the same reasoning as a stale copy being as wrong
 * as a missing file.
 *
 * Pure function over an injected `fs` -- no `bun` spawn, no filesystem
 * writes. `repoRoot` + the three named `fs` functions are the whole
 * surface; any absolute path a caller passes through `repoRoot` is used
 * as-is, so the returned `expectedLink` paths are whatever shape the
 * caller's `repoRoot` was (absolute in production use, arbitrary in tests).
 */

import * as fs from 'node:fs';
import { join } from 'node:path';

const SCOPE_PREFIX = '@agent-console/';

/** Every `@agent-console/*` dependency name (scope stripped), deduped and
 * sorted, declared in either `dependencies` or `devDependencies`. */
function collectAgentConsoleDeps(packageJson) {
  const deps = new Set();
  for (const field of ['dependencies', 'devDependencies']) {
    const map = packageJson[field];
    if (!map) continue;
    for (const name of Object.keys(map)) {
      if (name.startsWith(SCOPE_PREFIX)) {
        deps.add(name.slice(SCOPE_PREFIX.length));
      }
    }
  }
  return [...deps].sort();
}

/** Check one `package.json` location's `@agent-console/*` deps against its
 * own `node_modules/@agent-console/<name>` symlinks. Returns the missing
 * entries for this package only (empty array if none, or if there is no
 * `package.json` at `packageJsonPath` at all -- e.g. a `packages/*` entry
 * that isn't a workspace member). */
function checkPackageLinks(pkgLabel, packageJsonPath, nodeModulesDir, { readFileSync, lstatSync }) {
  const missing = [];
  let raw;
  try {
    raw = readFileSync(packageJsonPath, 'utf-8');
  } catch {
    return missing;
  }
  const packageJson = JSON.parse(raw);
  const deps = collectAgentConsoleDeps(packageJson);
  for (const dep of deps) {
    const expectedLink = join(nodeModulesDir, '@agent-console', dep);
    let stat;
    try {
      stat = lstatSync(expectedLink);
    } catch {
      missing.push({ pkg: pkgLabel, dep, expectedLink });
      continue;
    }
    if (!stat.isSymbolicLink()) {
      missing.push({ pkg: pkgLabel, dep, expectedLink });
    }
  }
  return missing;
}

/**
 * @param {string} repoRoot absolute path to the repository root
 * @param {{ readFileSync: Function, readdirSync: Function, lstatSync: Function }} [fsImpl]
 * @returns {{ missing: Array<{ pkg: string, dep: string, expectedLink: string }> }}
 */
export function checkWorkspaceLinks(repoRoot, { readFileSync, readdirSync, lstatSync } = fs) {
  const fsImpl = { readFileSync, readdirSync, lstatSync };
  const missing = [];

  // The repo root's own package.json can declare @agent-console/* deps too
  // (none today -- see the AC's root-check requirement -- but the check is
  // symmetric with every packages/* member rather than special-cased away).
  missing.push(
    ...checkPackageLinks('root', join(repoRoot, 'package.json'), join(repoRoot, 'node_modules'), fsImpl),
  );

  const packagesDir = join(repoRoot, 'packages');
  let entries = [];
  try {
    entries = readdirSync(packagesDir);
  } catch {
    entries = [];
  }

  for (const entry of [...entries].sort()) {
    const pkgDir = join(packagesDir, entry);
    let stat;
    try {
      stat = lstatSync(pkgDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    missing.push(
      ...checkPackageLinks(entry, join(pkgDir, 'package.json'), join(pkgDir, 'node_modules'), fsImpl),
    );
  }

  return { missing };
}
