import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  copyFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { getLibCandidateFilenames } from './src/lib/bun-pty-shim.ts';

const __dirname = dirname(new URL(import.meta.url).pathname);
const distDir = join(__dirname, '../../dist');

// Native modules that need to be installed separately (not bundled by Bun)
// These are typically platform-specific binaries that cannot be bundled
const NATIVE_DEPENDENCIES = ['bun-pty'] as const;

// Read server package.json to get dependency versions
const serverPkgPath = join(__dirname, 'package.json');
const serverPkg = JSON.parse(readFileSync(serverPkgPath, 'utf-8')) as {
  dependencies: Record<string, string>;
};

// Extract native dependencies with their versions
function getNativeDependencies(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const dep of NATIVE_DEPENDENCIES) {
    const version = serverPkg.dependencies[dep];
    if (version) {
      result[dep] = version;
    } else {
      console.warn(`Warning: Native dependency "${dep}" not found in package.json`);
    }
  }
  return result;
}

mkdirSync(distDir, { recursive: true });

// 1. Bundle the actual server -> dist/server.js
const serverBuild = await Bun.build({
  entrypoints: [join(__dirname, 'src/index.ts')],
  outdir: distDir,
  target: 'bun',
  format: 'esm',
  sourcemap: 'external',
  naming: { entry: 'server.[ext]' },
});

if (!serverBuild.success) {
  console.error('Server build failed:');
  for (const message of serverBuild.logs) {
    console.error(message);
  }
  process.exit(1);
}

// 2. Bundle the shim entry -> dist/index.js.
//    The shim uses a runtime-computed URL (`new URL('./server.js', ...)`)
//    when dynamic-importing the real server bundle so Bun's bundler does not
//    try to resolve and inline server.js into the shim.
const shimBuild = await Bun.build({
  entrypoints: [join(__dirname, 'src/shim.ts')],
  outdir: distDir,
  target: 'bun',
  format: 'esm',
  sourcemap: 'external',
  naming: { entry: 'index.[ext]' },
});

if (!shimBuild.success) {
  console.error('Shim build failed:');
  for (const message of shimBuild.logs) {
    console.error(message);
  }
  process.exit(1);
}

// 3. Copy the bun-pty native library for the current platform into dist/.
//    bun-pty's resolveLibPath() will pick this up via process.env.BUN_PTY_LIB
//    set by the shim. We copy via the workspace symlink which abstracts the
//    .bun/bun-pty@<version> directory.
const libSourceDir = join(
  __dirname,
  'node_modules',
  'bun-pty',
  'rust-pty',
  'target',
  'release'
);
if (!existsSync(libSourceDir)) {
  console.error(
    `bun-pty native library source directory not found: ${libSourceDir}\n` +
      `Run \`bun install\` to populate the workspace symlink.`
  );
  process.exit(1);
}

const libDestDir = join(distDir, 'rust-pty', 'target', 'release');
mkdirSync(libDestDir, { recursive: true });

const candidateFilenames = getLibCandidateFilenames(process.platform, process.arch);
const copiedLibs: string[] = [];
for (const filename of candidateFilenames) {
  const src = join(libSourceDir, filename);
  if (existsSync(src)) {
    const dest = join(libDestDir, filename);
    copyFileSync(src, dest);
    copiedLibs.push(filename);
  }
}

if (copiedLibs.length === 0) {
  console.error(
    `No bun-pty native library candidates found in ${libSourceDir} for ` +
      `platform=${process.platform} arch=${process.arch}.\n` +
      `Expected one of: ${candidateFilenames.join(', ')}`
  );
  process.exit(1);
}

// 4. Generate dist/package.json for standalone distribution.
//    bin/scripts still point at index.js — which is now the shim — so the
//    on-disk contract for systemd / `bun run start` is unchanged.
const distPackageJson = {
  name: 'agent-console',
  version: '0.1.0',
  type: 'module',
  bin: {
    'agent-console': './index.js',
  },
  scripts: {
    start: 'bun index.js',
  },
  engines: {
    bun: '>=1.3.5', // Bun.Terminal requires 1.3.5+
  },
  dependencies: getNativeDependencies(),
};

writeFileSync(
  join(distDir, 'package.json'),
  JSON.stringify(distPackageJson, null, 2) + '\n'
);

// 5. Prepend the CLI shebang to the shim (not the server bundle — the server
//    is loaded via dynamic import, never executed directly).
const indexPath = join(distDir, 'index.js');
const indexContent = readFileSync(indexPath, 'utf-8');
if (!indexContent.startsWith('#!')) {
  writeFileSync(indexPath, `#!/usr/bin/env bun\n${indexContent}`);
  chmodSync(indexPath, 0o755);
}

console.log('Build complete:');
console.log('  dist/index.js   (shim, sets BUN_PTY_LIB and loads server.js)');
console.log('  dist/server.js  (bundled server)');
console.log(`  dist/rust-pty/target/release/  (copied: ${copiedLibs.join(', ')})`);
console.log('  dist/package.json');
