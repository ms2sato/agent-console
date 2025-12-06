import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '../../dist');

// Bundle server with esbuild
await build({
  entryPoints: [join(__dirname, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(distDir, 'index.js'),
  external: ['node-pty', 'ws'], // Native module + CJS module with dynamic require
  sourcemap: true,
});

// Generate dist/package.json for standalone distribution
const distPackageJson = {
  name: 'agent-console',
  version: '0.1.0',
  type: 'module',
  scripts: {
    start: 'node index.js',
  },
  dependencies: {
    'node-pty': '^1.0.0',
    'ws': '^8.18.0',
  },
  engines: {
    node: '>=22.0.0',
  },
};

mkdirSync(distDir, { recursive: true });
writeFileSync(
  join(distDir, 'package.json'),
  JSON.stringify(distPackageJson, null, 2) + '\n'
);

console.log('Build complete: dist/index.js');
console.log('Generated: dist/package.json');
