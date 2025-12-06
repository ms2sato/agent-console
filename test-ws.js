import WebSocket from 'ws';
import * as readline from 'readline';

// Connect to agent-console via WebSocket (like browser does)
const sessionId = process.argv[2];

if (!sessionId) {
  console.log('Usage: node test-ws.js <sessionId>');
  console.log('First create a session via browser, then use this to connect');
  process.exit(1);
}

const wsUrl = `ws://localhost:6340/ws/terminal/${sessionId}`;
console.log('Connecting to:', wsUrl);

const ws = new WebSocket(wsUrl);

ws.on('open', () => {
  console.log('WebSocket connected');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'output') {
    process.stdout.write(msg.data);
  } else if (msg.type === 'history') {
    process.stdout.write(msg.data);
  } else if (msg.type === 'exit') {
    console.log('\n--- EXIT ---');
    console.log('Exit code:', msg.exitCode);
    console.log('Signal:', msg.signal);
    process.exit(0);
  } else if (msg.type === 'activity') {
    console.log(`[Activity: ${msg.state}]`);
  }
});

ws.on('close', () => {
  console.log('WebSocket closed');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err);
  process.exit(1);
});

// Read input from terminal and send via WebSocket
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (data) => {
  const str = data.toString();

  // Send as JSON like browser does
  const msg = JSON.stringify({ type: 'input', data: str });
  ws.send(msg);
});
