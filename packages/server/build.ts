import { writeFileSync, mkdirSync } from 'fs';
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
  external: ['@zenyr/bun-pty'], // Native module
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
  type: 'module',
  scripts: {
    start: 'bun index.js',
  },
  dependencies: {
    '@zenyr/bun-pty': '^0.4.4',
  },
};

mkdirSync(distDir, { recursive: true });
writeFileSync(
  join(distDir, 'package.json'),
  JSON.stringify(distPackageJson, null, 2) + '\n'
);

console.log('Build complete: dist/index.js');
console.log('Generated: dist/package.json');
