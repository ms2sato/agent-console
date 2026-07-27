/**
 * TEMPORARY diagnostic for Issue #1225. Removed before PR finalization.
 * Isolates candidate 3: Bun.spawn() + subprocess.kill() + await .exited,
 * mirroring EmbeddedAgentWorkerService's real subprocess lifecycle
 * (spawnAsUser -> Bun.spawn under the hood, safeKill -> subprocess.kill()),
 * without ever touching GlobalRegistrator and without node:child_process.
 */
import { describe, it } from 'bun:test';

describe('Issue #1225 -- Bun.spawn + kill + exited only', () => {
  it('spawns a real Bun.Subprocess, kills it, and awaits exit', async () => {
    const subprocess = Bun.spawn(['sleep', '30'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    subprocess.kill(15);
    await subprocess.exited;
  });
});
