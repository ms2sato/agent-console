#!/usr/bin/env bun
// Hard-fail when Bun is too old to satisfy the repo's minimum version.
// Three reasons for the floor:
//   - `minimumReleaseAge` (the supply-chain age gate in bunfig.toml) was added
//     in Bun 1.3.0. An older Bun silently ignores the setting.
//   - `Bun.Terminal` (used by packages/server) requires Bun 1.3.5+.
//   - On Bun 1.3.5-1.3.13, `Bun.spawn({ terminal })` never delivers
//     `terminal.data` callbacks when the spawn call happens inside an active
//     AsyncLocalStorage context (e.g. the MCP request scope), so agent worker
//     PTYs created via MCP `delegate_to_worktree` produce no output at all.
//     Fixed upstream in Bun 1.3.14. Regression gate:
//     `bun run check:pty-als-data`.
// The higher floor wins: 1.3.14. Bun's `engines` enforcement is advisory
// (warning only) as of Bun 1.3.x, so we need this explicit check.

const MIN_BUN_VERSION = "1.3.14";

if (typeof Bun === "undefined") {
  console.error("This project must be installed with Bun (https://bun.com).");
  console.error("Detected non-Bun runtime executing the preinstall hook.");
  process.exit(1);
}

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
  console.error(
    `agent-console requires Bun >= ${MIN_BUN_VERSION} (detected ${Bun.version}).`,
  );
  console.error(
    "Older Bun versions break this project: PTY terminal.data delivery is",
  );
  console.error(
    "broken inside AsyncLocalStorage contexts on Bun 1.3.5-1.3.13, and the",
  );
  console.error(
    "`minimumReleaseAge` supply-chain age gate needs Bun >= 1.3.0.",
  );
  console.error("Upgrade Bun: https://bun.com/docs/installation");
  process.exit(1);
}
