import * as pty from 'node-pty';

// Simplified ActivityDetector (same logic as agent-console)
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

class ActivityDetector {
  constructor() {
    this.buffer = '';
    this.outputHistory = [];
    this.rateWindowMs = 2000;
    this.activeCountThreshold = 20;
  }

  processOutput(data) {
    const now = Date.now();
    const cleanData = data.replace(ANSI_REGEX, '');

    // Same logging as real ActivityDetector
    if (cleanData.length > 0) {
      console.log(`[ActivityDetector] Received output (${cleanData.length} chars): ${JSON.stringify(cleanData)}`);
    }

    this.buffer += data;
    if (this.buffer.length > 1000) {
      this.buffer = this.buffer.slice(-1000);
    }

    this.outputHistory.push({ time: now });
    this.outputHistory = this.outputHistory.filter(
      entry => now - entry.time < this.rateWindowMs
    );

    const outputCount = this.outputHistory.length;
    console.log(`[ActivityDetector] Output count: ${outputCount} in ${this.rateWindowMs}ms window`);
  }

  dispose() {
    this.buffer = '';
    this.outputHistory = [];
  }
}

const worktreePath = '/Users/ms2sato/.agent-console/worktrees/ms2sato/agent-console/testbrunch';

// Same env filtering as agent-console
const BLOCKED_ENV_VARS = ['NODE_ENV', 'PORT', 'HOST'];
const filteredEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
    filteredEnv[key] = value;
  }
}

console.log('Starting Claude Code via node-pty...');
console.log('Working directory:', worktreePath);

const activityDetector = new ActivityDetector();

// Try with -c flag like agent-console Continue does
const ptyProcess = pty.spawn('claude', ['-c'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: worktreePath,
  env: filteredEnv,
});

console.log('Claude PID:', ptyProcess.pid);

// Output buffer like SessionManager
let outputBuffer = '';
const MAX_BUFFER_SIZE = 100000;

ptyProcess.onData((data) => {
  // Buffer output for reconnection (like SessionManager)
  outputBuffer += data;
  if (outputBuffer.length > MAX_BUFFER_SIZE) {
    outputBuffer = outputBuffer.slice(-MAX_BUFFER_SIZE);
  }

  // Same as agent-console: process with ActivityDetector
  activityDetector.processOutput(data);

  // Simulate ws.send() like agent-console does
  const msg = JSON.stringify({ type: 'output', data });
  // Just stringify, don't actually send anywhere

  process.stdout.write(data);
});

ptyProcess.onExit(({ exitCode, signal }) => {
  console.log('\n--- PTY EXIT ---');
  console.log('Exit code:', exitCode);
  console.log('Signal:', signal);
  process.exit(0);
});

// Forward stdin to pty (with writeInput logic like SessionManager)
process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
  const str = data.toString();

  // Same logic as SessionManager.writeInput()
  console.log(`[writeInput]: ${JSON.stringify(str)}`);

  if (str.includes('\r')) {
    console.log('[writeInput] Enter pressed');
  } else if (str === '\x1b') {
    console.log('[writeInput] ESC pressed');
  } else if (str === '\x1b[I' || str === '\x1b[O') {
    console.log('[writeInput] Focus event ignored');
  } else {
    console.log('[writeInput] User typing');
  }

  ptyProcess.write(str);
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\nSIGINT received, killing pty...');
  ptyProcess.kill();
});
