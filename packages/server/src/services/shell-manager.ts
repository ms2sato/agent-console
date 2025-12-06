import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import { getChildProcessEnv } from './env-filter.js';

interface ShellInstance {
  id: string;
  pty: pty.IPty;
  cwd: string;
}

class ShellManager {
  private shells: Map<string, ShellInstance> = new Map();

  createShell(
    cwd: string,
    onData: (data: string) => void,
    onExit: (exitCode: number, signal: string | null) => void
  ): string {
    const id = uuidv4();

    // Detect default shell
    const shell = process.env.SHELL || '/bin/bash';

    const ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: getChildProcessEnv(),
    });

    ptyProcess.onData(onData);
    ptyProcess.onExit(({ exitCode, signal }) => {
      onExit(exitCode, signal ? String(signal) : null);
      this.shells.delete(id);
    });

    this.shells.set(id, { id, pty: ptyProcess, cwd });
    console.log(`Shell created: ${id} in ${cwd}`);

    return id;
  }

  writeInput(id: string, data: string): void {
    const shell = this.shells.get(id);
    if (shell) {
      shell.pty.write(data);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const shell = this.shells.get(id);
    if (shell) {
      shell.pty.resize(cols, rows);
    }
  }

  destroyShell(id: string): void {
    const shell = this.shells.get(id);
    if (shell) {
      shell.pty.kill();
      this.shells.delete(id);
      console.log(`Shell destroyed: ${id}`);
    }
  }

  getShell(id: string): ShellInstance | undefined {
    return this.shells.get(id);
  }
}

export const shellManager = new ShellManager();
