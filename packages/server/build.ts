import { writeFileSync, readFileSync, mkdirSync, chmodSync } from 'fs';
import { dirname, join } from 'path';

const __dirname = dirname(new URL(import.meta.url).pathname);
const distDir = join(__dirname, '../../dist');

// Bundle server with Bun's built-in bundler
const result = await Bun.build({
  entrypoints: [join(__dirname, 'src/index.ts')],
  outdir: distDir,
  target: 'bun',
  format: 'esm',
  sourcemap: 'external',
  external: ['bun-pty'], // Native module
});

if (!result.success) {
  console.error('Build failed:');
  for (const message of result.logs) {
    console.error(message);
  }
  process.exit(1);
}

// Generate dist/package.json for standalone distribution
const distPackageJson = {
  name: 'agent-console',
  version: '0.1.0',
  description: 'A web application for managing multiple Claude Code instances',
  type: 'module',
  bin: {
    'agent-console': './index.js',
  },
  scripts: {
    start: 'bun index.js',
  },
  engines: {
    bun: '>=1.3.0',
  },
  dependencies: {
    'bun-pty': '^0.4.2',
  },
  engines: {
    bun: '>=1.3.0',
  },
  repository: {
    type: 'git',
    url: 'git+https://github.com/ms2sato/agent-console.git',
  },
  keywords: ['claude', 'claude-code', 'terminal', 'pty', 'bun'],
  author: 'ms2sato',
  license: 'MIT',
  bugs: {
    url: 'https://github.com/ms2sato/agent-console/issues',
  },
  homepage: 'https://github.com/ms2sato/agent-console#readme',
};

mkdirSync(distDir, { recursive: true });
writeFileSync(
  join(distDir, 'package.json'),
  JSON.stringify(distPackageJson, null, 2) + '\n'
);

// Add shebang to index.js for CLI execution
const indexPath = join(distDir, 'index.js');
const indexContent = readFileSync(indexPath, 'utf-8');
if (!indexContent.startsWith('#!')) {
  writeFileSync(indexPath, `#!/usr/bin/env bun\n${indexContent}`);
  chmodSync(indexPath, 0o755);
}

console.log('Build complete: dist/index.js');
console.log('Generated: dist/package.json');
