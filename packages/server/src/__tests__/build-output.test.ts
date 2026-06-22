import { describe, test, expect } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLibCandidateFilenames } from '../lib/bun-pty-shim.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/server/src/__tests__/ -> packages/server/
const serverPkgDir = join(__dirname, '..', '..');
// build.ts writes to <repo-root>/dist (packages/server/../../dist)
const distDir = join(serverPkgDir, '..', '..', 'dist');

/**
 * Reads real-fs file contents in a subprocess. Other tests in the same
 * `bun test` run mock the `fs` module process-globally via `mock.module`
 * (see `__tests__/utils/mock-fs-helper.ts`), which makes intra-process fs /
 * `Bun.file()` calls non-deterministic when this suite is interleaved with
 * memfs-using suites. Spawning a fresh subprocess sidesteps the mock.
 */
async function inspectDist(distPath: string): Promise<{
  indexExists: boolean;
  indexFirstLine: string;
  indexContainsBunPtyLib: boolean;
  indexContainsServerJs: boolean;
  serverExists: boolean;
  serverSize: number;
  libDirEntries: string[];
  pkgRaw: string;
}> {
  const probe = `
    const { readFileSync, existsSync, statSync, readdirSync } = require('fs');
    const { join } = require('path');
    const dist = ${JSON.stringify(distPath)};
    const indexPath = join(dist, 'index.js');
    const serverPath = join(dist, 'server.js');
    const libDir = join(dist, 'rust-pty', 'target', 'release');
    const pkgPath = join(dist, 'package.json');

    const indexExists = existsSync(indexPath);
    const indexContent = indexExists ? readFileSync(indexPath, 'utf-8') : '';
    const indexFirstLine = indexContent.split('\\n')[0] + '\\n';

    const serverExists = existsSync(serverPath);
    const serverSize = serverExists ? statSync(serverPath).size : 0;

    const libDirEntries = existsSync(libDir) ? readdirSync(libDir) : [];
    const pkgRaw = existsSync(pkgPath) ? readFileSync(pkgPath, 'utf-8') : '';

    process.stdout.write(JSON.stringify({
      indexExists,
      indexFirstLine,
      indexContainsBunPtyLib: indexContent.includes('BUN_PTY_LIB'),
      indexContainsServerJs: indexContent.includes('./server.js'),
      serverExists,
      serverSize,
      libDirEntries,
      pkgRaw,
    }));
  `;
  const proc = Bun.spawn(['bun', '-e', probe], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`inspectDist probe failed (exit ${exitCode}): ${stderr}`);
  }
  return JSON.parse(stdout) as Awaited<ReturnType<typeof inspectDist>>;
}

describe('build output (dist/) shape', () => {
  test(
    'bun run build produces a self-contained dist/ that satisfies the shim contract',
    async () => {
      const proc = Bun.spawn(['bun', 'run', 'build'], {
        cwd: serverPkgDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        const stdout = await new Response(proc.stdout).text();
        console.error('build stdout:', stdout);
        console.error('build stderr:', stderr);
      }
      expect(exitCode).toBe(0);

      const info = await inspectDist(distDir);

      // dist/index.js — the shim
      expect(info.indexExists).toBe(true);
      expect(info.indexFirstLine).toBe('#!/usr/bin/env bun\n');
      expect(info.indexContainsBunPtyLib).toBe(true);
      expect(info.indexContainsServerJs).toBe(true);

      // dist/server.js — the real bundle (size sanity)
      expect(info.serverExists).toBe(true);
      expect(info.serverSize).toBeGreaterThan(1_000_000);

      // dist/rust-pty/target/release/ — at least one candidate for this platform
      const candidates = getLibCandidateFilenames(
        process.platform,
        process.arch
      );
      const found = info.libDirEntries.filter((e) => candidates.includes(e));
      expect(found.length).toBeGreaterThan(0);

      // dist/package.json — bin + start script point at the shim
      const pkg = JSON.parse(info.pkgRaw) as {
        bin: Record<string, string>;
        scripts: Record<string, string>;
      };
      expect(pkg.bin['agent-console']).toBe('./index.js');
      expect(pkg.scripts.start).toBe('bun index.js');
    },
    60_000
  );
});
