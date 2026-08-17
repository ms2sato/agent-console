/**
 * Preload for the "native" (DOM-free) e2e test invocation.
 *
 * WHY THIS INVOCATION EXISTS -- read before adding a test file here or
 * touching `../setup.ts`.
 *
 * The files under this directory (`embedded-agent-e2e.test.ts`,
 * `embedded-agent-artifact-e2e.test.ts`) drive a real embedded-agent
 * subprocess that talks to a REAL `/mcp` HTTP endpoint served via
 * `Bun.serve`. happy-dom's `GlobalRegistrator` (registered by `../setup.ts`
 * for the package's boundary tests) replaces the process-global `Response`
 * / `Headers` implementations, which makes `Bun.serve` serialize real HTTP
 * responses in a shape the loop subprocess's MCP client rejects
 * ("Unexpected content type"). These e2e files need pristine natives (real
 * `fetch` / `Response` / `Headers`), so this invocation's preload never
 * registers happy-dom in the first place -- see the `test` / `test:coverage`
 * / `test:watch` scripts in `../../package.json`, which run this directory
 * as a SEPARATE `bun test` process from the rest of `src/`.
 *
 * This separate-process design is not a style preference -- it is the fix
 * for a real CI-only failure. An earlier version of these two files toggled
 * `GlobalRegistrator.unregister()` / `.register()` around their own
 * `beforeAll`/`afterAll`, mid-process, inside the SAME `bun test` run as
 * every other file under `src/`. `@happy-dom/global-registrator`'s
 * `GlobalRegistrator` holds its registration state in a class-static
 * private field: genuinely process-global, shared by every test file
 * `bun test` loads into that one process (bun:test runs files sequentially
 * in a single process by default, so this is NOT a race). The hazard is
 * IDENTITY REPLACEMENT: `unregister()` followed by a later `register()`
 * produces a brand-new happy-dom window/document identity. Any module that
 * captured DOM-derived state at IMPORT TIME (React DOM's internals, React
 * Testing Library's bindings) silently splits across the two document
 * identities -- a later React Testing Library test in the same process can
 * render into a container from one document while `screen` queries another,
 * producing an empty `<body />` with nothing thrown. `bun test`'s file
 * execution order is directory-readdir order (not alphabetical), and
 * readdir order differs across OSes and filesystems, which is exactly why
 * the corruption only reproduced in CI and never locally. A third,
 * unrelated file (`agent-form-boundary.test.tsx`) was the observed victim;
 * removing the toggle files made its failure disappear (confirmed by a
 * paired-probe delta-debug), which is what pinned the root cause to the
 * toggle rather than to that victim file itself.
 *
 * The fix generalizes to a rule, not just these two files: NO test file in
 * this package may call `GlobalRegistrator.unregister()` or
 * `GlobalRegistrator.register()`. Process-level separation -- a distinct
 * `bun test` invocation with its own preload, so a whole process either
 * always has happy-dom registered or never does -- is the only sound
 * boundary for process-global state like this. This is enforced going
 * forward by a dedicated lint; do not reintroduce the toggle pattern to
 * work around a future DOM-vs-native conflict -- add the new file to this
 * directory (or a sibling native-invocation directory) instead.
 *
 * Unlike `../setup.ts`, this preload intentionally does NOT import
 * `mock-open-helper` (the `open` npm package `mock.module()` registration):
 * neither e2e file in this directory exercises `routes/system.ts`'s
 * "reveal in file manager" endpoints (the only callers of `open()`), so
 * there is no risk of a real desktop `open` invocation. Add that import
 * here if a future file under this directory reaches those endpoints.
 */
export {};
