import { describe, it, expect } from 'bun:test';
import { discoverSmokeFiles, hasEntryPointGuard, readSmokeFile } from './smoke-entry-points.js';

/**
 * Mechanical net for Issue #1289 ("smoke scripts crash on production-shaped
 * trees when NODE_ENV is unset"). Every `scripts/smoke/*` ENTRY POINT
 * (same glob + `import.meta.main` detection `registry-reachability.test.ts`
 * and `import-safety.test.ts` use, imported from `./smoke-entry-points.js`
 * rather than re-implemented) must handle `NODE_ENV` in exactly one of two
 * ways:
 *
 *   (a) NEUTRAL -- its first import is `./_env.js`, which defaults
 *       `NODE_ENV` to `production` for logging purposes only
 *       (`scripts/smoke/_env.ts`), or
 *   (b) SENSITIVE -- its basename is listed in `NODE_ENV_SENSITIVE_SMOKES`
 *       below (with a one-line reason) AND it contains the explicit,
 *       fail-fast `NODE_ENV` check instead of importing `./_env`.
 *
 * A file satisfying NEITHER would silently inherit whatever `NODE_ENV` the
 * invoking shell happens to have -- the exact crash Issue #1289 reports
 * on a production-shaped tree missing the `pino-pretty` devDependency. A
 * file satisfying BOTH would default `NODE_ENV` and then immediately
 * refuse to run because it is also unset, which cannot happen externally
 * but would indicate the two mechanisms were applied to the same file by
 * mistake.
 *
 * `scripts/smoke/_env.ts` itself is excluded from this net the same way
 * it is excluded from `registry-reachability.test.ts`'s and
 * `import-safety.test.ts`'s entry-point loops: it has no `import.meta.main`
 * guard, so `hasEntryPointGuard` returns false for it and it is a library,
 * not an entry point, under this net's and `test-trigger.md`'s shared
 * exemption.
 *
 * Polarity (measured manually, not re-run automatically by this file --
 * see PR #1289's body for the pasted before/after): temporarily removing
 * the `./_env.js` import from a neutral smoke makes this net name that
 * file as neither handled; temporarily adding the `./_env.js` import to a
 * sensitive smoke (while its explicit check and listing stay in place)
 * makes this net name that file as both.
 */

/**
 * The three smokes whose verified path reads `NODE_ENV` for behaviour, not
 * just log formatting -- each carries the explicit fail-fast check instead
 * of `./_env.js`. One-line reason per entry, measured against this file's
 * own content at the time this net was written (Issue #1289):
 */
export const NODE_ENV_SENSITIVE_SMOKES: readonly { basename: string; reason: string }[] = [
  {
    basename: 'check-artifact-sandbox-boundary.mjs',
    reason:
      "asserts the auth cookie's `secure` attribute via the real resolveAuthCookieSecure(serverConfig), and boots the real index.ts in-process, whose static-file-serving branch (gated on NODE_ENV==='production') requires a built public/index.html.",
  },
  {
    basename: 'check-artifact-server-story-e2e.mjs',
    reason:
      "boots the real index.ts in-process; index.ts's static-file-serving branch (gated on NODE_ENV==='production') requires a built public/index.html that does not exist on an unbuilt dev tree.",
  },
  {
    basename: 'check-webhook-issue-label-routing.ts',
    reason:
      "boots the real index.ts as a child process inheriting NODE_ENV via ...process.env; the same static-file-serving branch is observable in the child's boot.",
  },
];

const SENSITIVE_BASENAMES = new Set(NODE_ENV_SENSITIVE_SMOKES.map((s) => s.basename));

/**
 * The marker text both carry inside their explicit, fail-fast NODE_ENV
 * check -- see each sensitive smoke's own `if (!process.env.NODE_ENV) {...}`
 * block. Checked as a substring rather than parsed, matching this repo's
 * other content-based smoke nets (e.g. `ENTRY_POINT_GUARD`).
 */
const EXPLICIT_CHECK_MARKER = 'NODE_ENV must be set explicitly';

/**
 * Finds the specifier of the FIRST top-level `import` statement in a file,
 * handling both side-effect-only (`import './x';`) and binding forms
 * (`import { a } from './x';`, including multi-line ones), by matching
 * non-greedily from the first `import` at the start of a line to the first
 * quoted string that follows it. Anchored at line start (`^`, multiline)
 * so prose mentioning "import" inside a line comment or a block comment
 * (which never starts a line with the literal word `import`) is never mistaken
 * for a real import statement.
 */
function firstImportSpecifier(content: string): string | null {
  const match = content.match(/^import\s[\s\S]*?['"]([^'"]+)['"]/m);
  return match ? match[1] : null;
}

function importsEnvFirst(file: string): boolean {
  return firstImportSpecifier(readSmokeFile(file)) === './_env.js';
}

/**
 * Whether `./_env.js` is imported ANYWHERE in the file, at any import
 * position. A sensitive smoke must reject this unconditionally, not just
 * check its first import: a static import of `./_env.js` at any position
 * still evaluates (and defaults `NODE_ENV`) before any of the file's
 * runtime code runs, including the explicit check inside `main()` -- ESM
 * hoists and evaluates every static import ahead of module-level code,
 * regardless of where in the file the import statement is textually
 * written (CodeRabbit finding on PR #1911).
 */
function importsEnvAnywhere(file: string): boolean {
  const content = readSmokeFile(file);
  for (const match of content.matchAll(/^import\s[\s\S]*?['"]([^'"]+)['"]/gm)) {
    if (match[1] === './_env.js') return true;
  }
  return false;
}

function hasExplicitNodeEnvCheck(file: string): boolean {
  return readSmokeFile(file).includes(EXPLICIT_CHECK_MARKER);
}

const smokeFiles = discoverSmokeFiles();

describe('scripts/smoke/* NODE_ENV discipline (Issue #1289)', () => {
  it('discovers a non-trivial number of smoke scripts (the discovery glob itself is not silently empty)', () => {
    // Same "an empty discovery masks every assertion below" shape as the
    // sibling nets -- workflow.md sub-pattern 9.
    expect(smokeFiles.length).toBeGreaterThanOrEqual(20);
  });

  const entryPoints = smokeFiles.filter(hasEntryPointGuard);
  const libraries = smokeFiles.filter((f) => !hasEntryPointGuard(f));

  it('scripts/smoke/_env.ts exists and is excluded from this net as a library (no import.meta.main guard)', () => {
    expect(smokeFiles).toContain('_env.ts');
    expect(libraries).toContain('_env.ts');
    expect(entryPoints).not.toContain('_env.ts');
  });

  it('every NODE_ENV_SENSITIVE_SMOKES entry names a real, currently-discovered entry point', () => {
    for (const { basename } of NODE_ENV_SENSITIVE_SMOKES) {
      expect(entryPoints).toContain(basename);
    }
  });

  for (const file of entryPoints) {
    const envFirst = importsEnvFirst(file);
    const envAnywhere = importsEnvAnywhere(file);
    const isSensitive = SENSITIVE_BASENAMES.has(file);
    const hasCheck = hasExplicitNodeEnvCheck(file);

    // A sensitive file is correctly handled only when `./_env.js` is absent
    // from the ENTIRE file, not merely absent from the first-import slot --
    // see importsEnvAnywhere's own comment. `envFirst` therefore already
    // implies `envAnywhere`, which makes the "both" case below collapse
    // into this one: a file can never be both neutralCorrect and
    // sensitiveCorrect at the same time.
    const neutralCorrect = envFirst && !isSensitive;
    const sensitiveCorrect = isSensitive && hasCheck && !envAnywhere;

    it(`${file}: handles NODE_ENV in exactly one way (neutral ./_env.js import XOR sensitive explicit check)`, () => {
      if (isSensitive && envAnywhere) {
        throw new Error(
          `${file}: listed in NODE_ENV_SENSITIVE_SMOKES but imports ./_env.js somewhere in the file -- that ` +
            `import still defaults NODE_ENV before any of the file's runtime code (including an explicit check) ` +
            `ever executes, since ESM evaluates every static import ahead of module-level code regardless of ` +
            `position. Fix: remove the ./_env.js import entirely.`,
        );
      }
      if (isSensitive && !hasCheck) {
        throw new Error(
          `${file}: listed in NODE_ENV_SENSITIVE_SMOKES but has no explicit NODE_ENV check (no "${EXPLICIT_CHECK_MARKER}" marker). ` +
            `Fix: add the fail-fast check before any server import.`,
        );
      }
      if (!isSensitive && !envFirst) {
        throw new Error(
          `${file}: neither imports ./_env.js as its first import nor is a listed NODE_ENV-sensitive smoke -- ` +
            `it would silently inherit the invoking shell's NODE_ENV. Fix: add \`import './_env.js';\` as the ` +
            `first import if NODE_ENV has no behavioral effect on this smoke's verified path, or add it to ` +
            `NODE_ENV_SENSITIVE_SMOKES with the explicit fail-fast check if it does.`,
        );
      }
      expect(neutralCorrect !== sensitiveCorrect).toBe(true);
    });
  }
});
