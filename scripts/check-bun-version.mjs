#!/usr/bin/env bun
// Hard-fail when Bun is too old to satisfy the repo's minimum version.
// Two reasons for the floor:
//   - `minimumReleaseAge` (the supply-chain age gate in bunfig.toml) was added
//     in Bun 1.3.0. An older Bun silently ignores the setting.
//   - `Bun.Terminal` (used by packages/server) requires Bun 1.3.5+.
// The higher floor wins: 1.3.5. Bun's `engines` enforcement is advisory
// (warning only) as of Bun 1.3.x, so we need this explicit check.

const MIN_BUN_VERSION = "1.3.5";

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
    "Bun's `minimumReleaseAge` supply-chain age gate (configured in bunfig.toml)",
  );
  console.error(`only works on Bun >= ${MIN_BUN_VERSION}.`);
  console.error("Upgrade Bun: https://bun.com/docs/installation");
  process.exit(1);
}
