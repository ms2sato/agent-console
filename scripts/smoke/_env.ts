/**
 * Default `NODE_ENV` to `production` for smoke scripts whose verified path
 * does not depend on its value -- `NODE_ENV` only selects log formatting
 * for them (`packages/server/src/lib/logger.ts`'s `resolveLoggerConfig`).
 *
 * Owner constraint (Issue #1289): a smoke must never *silently* default
 * `NODE_ENV=production` when production semantics change the actual
 * behavior under test. Implicit defaulting is acceptable only where
 * `NODE_ENV` has no behavioral effect on the verified path; anywhere it
 * does (e.g. `Secure` cookie attribute, web-UI enablement, any env-gated
 * branch), the value must be set explicitly -- fail fast with a clear
 * message when unset rather than assuming. The three smokes for which that
 * is NOT the case do not import this module; see
 * `NODE_ENV_SENSITIVE_SMOKES` in `__tests__/node-env-discipline.test.ts`.
 *
 * `production` is the value chosen because it is the only one whose logger
 * branch needs no dev-only package: `resolveLoggerConfig` only constructs
 * the `pino-pretty` transport when `NODE_ENV` is unset or anything other
 * than `production`/`test`, and `pino-pretty` is a `devDependencies` entry
 * (absent on a `bun install --production` deploy tree), which is the exact
 * crash this module exists to prevent.
 *
 * Import this as the FIRST import of a neutral smoke's entry point --
 * `import './_env.js';` -- so this side effect runs before any
 * `packages/server/src` module is evaluated. ESM evaluates a module's
 * import declarations in source order, each to completion before the
 * next one starts, regardless of where in the file the import statements
 * are textually written (static imports are hoisted ahead of all other
 * module-level code) -- so being the first import guarantees this runs
 * before any later import's own transitive imports reach `logger.ts`.
 */
process.env.NODE_ENV ??= 'production';
