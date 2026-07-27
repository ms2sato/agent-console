/**
 * TEMPORARY diagnostic for Issue #1225. Removed before PR finalization.
 * Isolates candidate 1 (spawn + reap a real child process via
 * node:child_process, mirroring the embedded-agent loop subprocess
 * lifecycle) without ever touching GlobalRegistrator.
 */
import { describe, it } from 'bun:test';
import { spawn } from 'node:child_process';

describe('Issue #1225 -- real node:child_process spawn/reap only', () => {
  it('spawns and reaps a real short-lived child process', async () => {
    const child = spawn('sleep', ['0.2'], { stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
  });
});
