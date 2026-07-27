/**
 * Preload setup for boundary tests
 * Registers happy-dom globals for React/DOM testing
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();

// Force the `open` package mock.module() registration to run during
// preload -- before any test file's own import graph gets a chance to
// trigger routes/system.ts's first evaluation. bun:test's mock.module()
// only affects a module's binding at that module's FIRST evaluation; a
// test file that transitively imports routes/system.ts (e.g. via
// routes/api.ts) before this registration has run permanently binds
// `open` to the real npm package for the rest of the process, regardless
// of any later mock.module('open', ...) call. Importing only
// mock-open-helper.ts (not the full test-utils.ts) keeps this preload's
// side effects scoped to the one module this race affects -- it does not
// change which tests get the pty-provider mock.
import '@agent-console/server/src/__tests__/utils/mock-open-helper';
