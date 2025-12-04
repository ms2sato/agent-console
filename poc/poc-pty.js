#!/usr/bin/env node
// PoC: Claude Code を子プロセスとして起動し、stdin/stdout を制御

const pty = require('node-pty');
const readline = require('readline');

// 作業ディレクトリ（引数で指定可能）
const cwd = process.argv[2] || process.cwd();

console.log('=== Claude Code PTY PoC ===');
console.log(`Working directory: ${cwd}`);
console.log('Starting Claude Code...\n');

// Claude Code を PTY で起動
const claude = pty.spawn('claude', [], {
  name: 'xterm-color',
  cols: 120,
  rows: 30,
  cwd: cwd,
  env: process.env,
});

// Claude の出力を表示
claude.onData((data) => {
  process.stdout.write(data);
});

// Claude 終了時
claude.onExit(({ exitCode, signal }) => {
  console.log(`\n\n=== Claude exited (code: ${exitCode}, signal: ${signal}) ===`);
  process.exit(exitCode);
});

// ユーザー入力を Claude に転送
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// raw mode で入力を直接転送（Ctrl+C なども含めて）
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on('data', (data) => {
    claude.write(data.toString());
  });
} else {
  // 非TTYの場合は行単位
  rl.on('line', (line) => {
    claude.write(line + '\r');
  });
}

console.log('(Type your messages. Ctrl+C to exit)\n');
