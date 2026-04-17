/**
 * dependency-cruiser configuration for agent-console.
 *
 * Scope: structural boundary rules only. Cosmetic rules are intentionally
 * omitted — every rule here should indicate a design problem when violated.
 *
 * See docs/development/structural-metrics.md for intent, adding rules, and
 * how to grandfather legitimate exceptions.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    // ───────────────────────────────────────────────────────────────
    // Cycles and orphans
    // ───────────────────────────────────────────────────────────────
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Module A depends on B which (transitively) depends on A. ' +
        'Circular dependencies are a cohesion smell and often break bundlers, ' +
        'initialization order, and hot-reload. Extract the shared piece or ' +
        'invert the direction.',
      from: {},
      to: { circular: true },
    },
    // NOTE: "no-orphans" is intentionally not configured here. Dead-code detection
    // is delegated to `knip`, which understands package-level entry points
    // (TanStack Router file-based routes, bun test auto-discovery, framework
    // conventions) that dep-cruiser can only approximate with regex allowlists.

    // ───────────────────────────────────────────────────────────────
    // Package boundary: client ↔ server
    //   Client must consume server only via @agent-console/server/api-type
    //   (which is a type-only export). Runtime imports crossing the
    //   network boundary are a bug.
    // ───────────────────────────────────────────────────────────────
    {
      name: 'client-no-runtime-import-from-server',
      severity: 'error',
      comment:
        'Client code must not runtime-import server source. The only sanctioned ' +
        'cross-package dependency is `import type` from @agent-console/server/api-type. ' +
        'If you need shared runtime code, put it in packages/shared.',
      from: { path: '^packages/client/src' },
      to: {
        path: '^packages/server/src',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'server-no-import-from-client',
      severity: 'error',
      comment:
        'Server must not import client code. If code is needed on both sides, ' +
        'it belongs in packages/shared.',
      from: { path: '^packages/server/src' },
      to: { path: '^packages/client/src' },
    },

    // ───────────────────────────────────────────────────────────────
    // Deep-import ban (substitutability / encapsulation)
    //   Shared contracts live in packages/shared. Reaching into another
    //   package's src/ directly couples you to its internal structure.
    //   Exception: packages/integration is the designated boundary
    //   test layer and legitimately wires real internals together.
    // ───────────────────────────────────────────────────────────────
    {
      name: 'no-deep-import-into-shared',
      severity: 'error',
      comment:
        'Import from `@agent-console/shared` (the package entry) rather than ' +
        'reaching into packages/shared/src/* subpaths from outside the package. ' +
        'Deep imports couple callers to internal file layout.',
      from: {
        path: '^packages/(client|server)/src',
      },
      to: {
        path: '^packages/shared/src/(?!index\\.ts$)',
      },
    },

    // ───────────────────────────────────────────────────────────────
    // File / OS I/O boundary
    //   Route handlers and middleware must not touch fs or spawn
    //   processes directly — those concerns belong to lib/ or a
    //   dedicated service. A route doing fs is a cohesion smell.
    //
    //   Allowlist is derived from current reality, not wishful thinking.
    // ───────────────────────────────────────────────────────────────
    {
      name: 'no-fs-in-route-handlers',
      severity: 'error',
      comment:
        'Route handlers must not import fs directly. Encapsulate the I/O in ' +
        'packages/server/src/lib/** or a service. Keeping routes free of fs ' +
        'keeps the HTTP layer thin and the I/O surface auditable.',
      from: {
        path: '^packages/server/src/(routes|middleware|websocket)/(?!__tests__)',
        // GRANDFATHERED (baseline at introduction of this rule).
        // Each entry below has an open follow-up issue to extract fs usage
        // into lib/**. Once extracted, remove the file from this list.
        // See docs/development/structural-metrics.md for the migration plan.
        pathNot: [
          'packages/server/src/routes/workers\\.ts$', // file-upload: mkdir/unlink/Bun.write
          'packages/server/src/routes/worktrees\\.ts$', // stat(path) directory existence check
          'packages/server/src/routes/system\\.ts$', // filesystem probes for editor launch
        ],
      },
      to: {
        path: '^(node:)?(fs|fs/promises)$',
      },
    },
    {
      name: 'no-process-spawn-in-route-handlers',
      severity: 'error',
      comment:
        'Route handlers must not spawn processes directly. The external process ' +
        'surface (spawn, child_process) belongs in services or lib/ so it can be ' +
        'audited, mocked, and replaced. Note: Bun.spawn is a global and cannot be ' +
        'detected by import analysis — reviewers must catch that one manually until ' +
        'it is wrapped in a lib/ helper.',
      from: {
        path: '^packages/server/src/(routes|middleware|websocket)/(?!__tests__)',
      },
      to: {
        path: '^(node:)?child_process$',
      },
    },

    // ───────────────────────────────────────────────────────────────
    // Layer boundary within server
    //   Services are the business-logic layer. They must not depend
    //   on the delivery layer above them (routes, websocket handlers),
    //   otherwise you get a reverse dependency that defeats the layer.
    // ───────────────────────────────────────────────────────────────
    {
      name: 'no-reverse-dep-service-to-delivery',
      severity: 'error',
      comment:
        'Services must not import from routes/ or websocket/. Delivery code ' +
        'depends on services, not the other way around. If a service needs to ' +
        'notify the delivery layer, use a callback / event emitter injected at ' +
        'construction time.',
      from: { path: '^packages/server/src/services' },
      to: {
        path: '^packages/server/src/(routes|websocket)/',
      },
    },

    // ───────────────────────────────────────────────────────────────
    // Unresolvable / bad imports
    // ───────────────────────────────────────────────────────────────
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'Import points at a module that cannot be resolved. Likely a typo or ' +
        'a missing dependency declaration.',
      from: {
        // routeTree.gen.ts is generated by @tanstack/router-plugin during vite
        // build. It is gitignored and may not exist when dep-cruiser runs.
        pathNot: ['(^|/)packages/client/src/main\\.tsx$'],
      },
      to: { couldNotResolve: true },
    },
    {
      name: 'no-duplicate-dep-types',
      severity: 'warn',
      comment:
        'Dependency occurs more than once in package.json (e.g., declared both ' +
        'as dev and regular). Pick one.',
      from: {},
      to: {
        moreThanOneDependencyType: true,
        dependencyTypesNot: ['type-only'],
      },
    },
  ],

  options: {
    doNotFollow: {
      path: 'node_modules',
    },

    exclude: {
      path: [
        '(^|/)node_modules/',
        '(^|/)dist/',
        '(^|/)build/',
        '(^|/)coverage/',
        '(^|/)routeTree\\.gen\\.ts$',
        // GRANDFATHERED: vitest.config.ts exists but the project uses `bun test`,
        // not vitest. Tracked for removal via `knip` dead-code detection.
        '(^|/)packages/server/vitest\\.config\\.ts$',
      ],
    },

    // Resolve TS paths and workspace packages using the base tsconfig.
    tsConfig: {
      fileName: 'tsconfig.base.json',
    },

    // Workspace packages expose `types` and `main` fields.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['types', 'typings', 'main'],
    },

    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
