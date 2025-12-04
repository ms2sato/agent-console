#!/usr/bin/env node
// PoC: Claude Code + xterm.js (server side)

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const pty = require('node-pty');

const PORT = process.env.PORT || 3457;
const cwd = process.argv[2] || process.cwd();

// HTTP server for serving HTML
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'poc-xterm.html')));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');

  // Spawn Claude Code with PTY
  const claude = pty.spawn('claude', [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: cwd,
    env: process.env,
  });

  console.log(`Claude Code started (PID: ${claude.pid})`);

  // Send Claude output to browser
  claude.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  // Handle Claude exit
  claude.onExit(({ exitCode, signal }) => {
    console.log(`Claude exited (code: ${exitCode})`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
    }
  });

  // Receive input from browser
  ws.on('message', (msg) => {
    try {
      const { type, data, cols, rows } = JSON.parse(msg);
      if (type === 'input') {
        claude.write(data);
      } else if (type === 'resize') {
        claude.resize(cols, rows);
      }
    } catch (e) {
      console.error('Invalid message:', e);
    }
  });

  // Cleanup on disconnect
  ws.on('close', () => {
    console.log('Client disconnected');
    claude.kill();
  });
});

server.listen(PORT, () => {
  console.log(`=== Claude Code xterm.js PoC ===`);
  console.log(`Working directory: ${cwd}`);
  console.log(`Open: http://localhost:${PORT}`);
});
