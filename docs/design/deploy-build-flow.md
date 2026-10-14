# Deploy Build Flow: what depends on the source working tree, and how to build a pinned SHA

Status: phase 0 review (docs only; no script was edited and no deploy was run). Issue [#919](https://github.com/ms2sato/agent-console/issues/919), phase 0 of the staged plan that starts from [source-repo-storage-model.md](source-repo-storage-model.md) section 6.

Claims are read at `origin/main` **`9408c731`** and cited as `file:line` there. Measurements were taken on this host (bun 1.3.14) in scratch clones under the delegate's own scratchpad; the commands are quoted. Nothing here touched the deploy target or used elevation.

## Summary

- Today the multi-user deploy builds IN the source repository's working tree and then copies the WHOLE tree; the two single-user scripts build in the checkout they live in and copy `dist/` only. Only the first needs the source to have a working tree; all three guard against a concurrent ref move with two HEAD re-checks.
- A pinned-SHA build (`git archive <sha>` into a fresh directory) removes the deploy's only dependency on the source working tree, makes `DEPLOYED_SHA` an input instead of an observation, and makes both HEAD re-checks unnecessary.
- **Measured, and it changes the earlier recommendation:** the install step is not the cost. A cold install into a fresh directory (warm global cache) took a median of 0.72 s and a warm one 0.24 s; the build takes 22 to 26 s. The persistent build worktree's only advantage, a kept `node_modules`, is worth about half a second on this host (about 4 s with an empty global cache), so the simpler stateless `git archive` shape is recommended over the persistent worktree that `source-repo-storage-model.md` section 6 leaned towards.
- **A new finding that rules the persistent worktree out on a bare source repository:** `bun install` inside a linked worktree of a bare repo exits 1, because the `postinstall` script resolves the repository root as the parent of `git rev-parse --git-common-dir`, which on a bare repo is the bare directory itself (section 4.3).
- The deployed tree's runtime needs are smaller than what is copied: `dist/` is a self-contained package (its own `package.json`, one native dependency). On a tree without `.git` (which is what the multi-user target already is, because the rsync excludes it) `GET /api/skills` already returns an empty list; this is a pre-existing behaviour, not something the change would introduce (section 2.3).

## 1. Inventory of the three deploy scripts

"Reads the working tree" means the step opens files that exist only in a checked-out tree. "What breaks if the source were bare" is taken from `source-repo-storage-model.md` section 6, not re-derived.

### 1.1 `scripts/update-and-deploy-for-multiuser-ubuntu.sh`

(This table inventories the script as it was BEFORE the Issue #2090 change; line numbers refer to that revision. Section 6 describes the shipped flow.)

| Step (line) | Reads the working tree? | Refs only? | Writes where | If the source were bare |
|---|---|---|---|---|
| `SRC` = `${DATA_ROOT}/source-repos/agent-console` or `AGENT_CONSOLE_APP_SOURCE_DIR` (`:118`) | no | no | nothing | n/a |
| Pre-check `git -C $SRC log --oneline -1` (`:275-276`) | no | yes | nothing | works (`HEAD` follows the default branch) |
| Capture `DEPLOYED_SHA` = `git -C $SRC rev-parse HEAD` (`:282`) | no | yes | shell variable | works |
| 1/6 `bun install` in `$SRC` (`:285-289`) | **yes** (`package.json`, `bun.lock`) | no | `$SRC/node_modules` | **breaks**: nothing to install |
| 2/6 `NODE_ENV=production bun run build` in `$SRC` (`:292-296`) | **yes** (every source file) | no | `$SRC/dist`, `$SRC/packages/*/dist`, `$SRC/packages/client/src/routeTree.gen.ts` | **breaks** |
| HEAD re-check after build (`:298-303`) | no | yes | nothing | works |
| 3/6 `rsync -a --delete --exclude=node_modules --exclude=.git $SRC/ $DST/` (`:306-309`) | **yes** (the whole tree, untracked and ignored files included) | no | `$DST` (the deploy target) | **breaks** |
| HEAD re-check after rsync (`:311-316`) | no | yes | nothing | works |
| 4/6 marker `.deploy-sha` (`:318-325`) | no | no | `$DST/.deploy-sha` | works |
| 5/6 copy `dist/embedded-agent.js` (+ map) to the unified entry path (`:353-355`) | reads `$DST/dist`, not `$SRC` | no | `UNIFIED_ENTRY_PATH` | works |
| 6/6 `bun install --production` in `$DST` (`:358-362`) | reads `$DST/package.json`, `bun.lock` | no | `$DST/node_modules` | works |

### 1.2 `scripts/update-and-deploy-for-ubuntu.sh` (single user)

`PROJECT_DIR` is the checkout the script lives in (`:21`), not a separate source repository.

| Step (line) | Reads the working tree? | Refs only? | Writes where | If the source were bare |
|---|---|---|---|---|
| `bun install` in `PROJECT_DIR` (`:33`) | **yes** | no | `node_modules` | n/a: the operator's own checkout is never bare |
| Capture `DEPLOYED_SHA` (`:70`) | no | yes | shell variable | n/a |
| `NODE_ENV=production bun run build` (`:73`) | **yes** | no | `dist/` in the checkout | n/a |
| HEAD re-check (`:75`, `:85`) | no | yes | nothing | n/a |
| `rsync -av --delete --exclude node_modules dist/ ~/.agent-console/server/` (`:83`) | reads **`dist/` only** | no | `~/.agent-console/server/` | n/a |
| marker (`:91-97`) | no | no | `~/.agent-console/server/.deploy-sha` | n/a |
| `bun install --production` in the target (`:100`) | reads `dist/package.json` copy | no | `~/.agent-console/server/node_modules` | n/a |

### 1.3 `scripts/update-and-deploy-for-mac.sh`

Same shape as 1.2: `bun install` (`:10`), capture SHA (`:68`), build (`:71`), re-checks (`:73`, `:86`), `rsync ... dist/ ~/.agent-console/server/` (`:81`), copy of `/tmp/agent-console-start.sh` (`:82`), marker (`:92-98`), `bun install --production` (`:101`), then a launchd restart.

**The asymmetry:** only the multi-user script copies the whole tree; the two single-user scripts already deploy `dist/` only. Section 2 measures whether the whole-tree copy buys the multi-user target anything at runtime.

## 2. What the deployed tree needs at runtime

### 2.1 From the unit and the start script

- `scripts/agent-console-multiuser.service.template:10-11`: `WorkingDirectory={{HOME}}/agent-console`, `ExecStart={{BUN_PATH}} run start`; `NODE_ENV=production` (`:19`).
- `package.json:14`: `start` is `NODE_ENV=production "$npm_execpath" dist/index.js`, so the target needs the root `package.json` and `dist/index.js` (or, for a `dist/`-only target, the `package.json` that the server build generates into `dist/`, `packages/server/build.ts:146-166`, whose `start` is `bun index.js`).
- `dist/` contents after `bun run build` (measured): `index.js`, `server.js`, `embedded-agent.js` (+ `.map`s), `public/`, `rust-pty/`, `package.json`; 21 MB. `dist/package.json` declares one dependency, `bun-pty`.

### 2.2 Items and the code that reads them

| Runtime need | Read at | Provided by |
|---|---|---|
| `dist/index.js`, `dist/server.js` | `package.json:14` / `dist/package.json` | the build |
| `dist/public` (static files, `index.html` cached at startup) | `packages/server/src/index.ts:189-190` (`import.meta.url`-relative) | the build |
| `.deploy-sha` at the working directory | `lib/deployed-sha.ts:29` (`process.cwd()`) | the deploy marker step |
| `dist/embedded-agent.js` | `services/embedded-agent-worker-service.ts:126` (`import.meta.dir` default) and the unified entry path | the build; copied to `UNIFIED_ENTRY_PATH` by the script |
| `rust-pty/` native library and `bun-pty` | `shim.ts:28,46` (`import.meta.url`) | the build and `bun install --production` |
| the working directory is a git checkout | `routes/skills.ts:12` | **nothing on a deploy target** (section 2.3) |

### 2.3 Measured: `GET /api/skills` on a tree without `.git`

`routes/skills.ts:12` runs `git rev-parse --show-toplevel` with `process.cwd()` and scans the result for skills. Measured by running the built server from (a) a `dist/`-only copy (plus `bun install --production`) and (b) the full tree the multi-user rsync produces (`--exclude=node_modules --exclude=.git`, plus `bun install --production`), both with no `.git`, isolated ports, a throwaway data directory and a scrubbed environment:

```
== dist-only copy (25 MB)         GET /api/skills -> {"skills":[]} [200]   GET /api/config deployedSha -> 9408c731...   GET / -> 200
== full tree minus .git (832 MB)  GET /api/skills -> {"skills":[]} [200]   GET /api/config deployedSha -> 9408c731...   GET / -> 200
server log: skills-route "git rev-parse failed: fatal: not a git repository (or any of the parent directories)"
```

So on today's multi-user target, which has no `.git`, `/api/skills` already returns an empty list, and the route logs a warning per request. The whole-tree copy buys nothing for this route; the stripped `dist/` copy behaves identically on all three calls. (Whether an empty skills list is the intended deploy behaviour is a separate question this review does not decide.)

### 2.4 Other readers of `process.cwd()` / `import.meta.dir`

```
$ grep -rn "process\.cwd()\|import\.meta\.dir\|import\.meta\.dirname\|__dirname\|import\.meta\.url" --include=*.ts packages/server/src | grep -v __tests__
index.ts:189:  const __dirname = path.dirname(new URL(import.meta.url).pathname);
shim.ts:28:const here = dirname(fileURLToPath(import.meta.url));
shim.ts:46:const serverUrl = new URL('./server.js', import.meta.url).href;
services/embedded-agent-worker-service.ts:126:  baseDir: string = import.meta.dir
lib/deployed-sha.ts:29:export async function readDeployedSha(cwd: string = process.cwd()): Promise<string | null> {
routes/skills.ts:12:      const repoRoot = (await git(['rev-parse', '--show-toplevel'], process.cwd())).trim();
```

(The remaining hits are comments.) Everything except `skills.ts` resolves relative to `dist/` or reads the marker in the working directory.

## 3. What a pinned-SHA build is

- **Inputs:** the SHA (a tree), `bun.lock` (at that SHA), the bun version (`engines.bun >= 1.3.5`, enforced by `scripts/check-bun-version.mjs`, run from `postinstall`). Outputs: `dist/` plus, for the multi-user copy, the root `package.json` set.
- **The generators are build steps and need no checked-in state.** `bun run build` runs `shared build` = `bun ../../scripts/generate-schema-version.mjs && tsc` (`packages/shared/package.json:15`), then the client's `vite build` (`TanStackRouterVite` generates `routeTree.gen.ts`, `packages/client/vite.config.ts:4,10`), then the server's `bun build.ts`. Measured on a fresh archive of `9408c731`: the archive contains `schema-version.gen.ts` (tracked) and does NOT contain `routeTree.gen.ts` (ignored, `.gitignore:30`); after `bun run build` the latter exists (19 293 bytes), and the former's sha256 prefix is `ebd85aadcf4dcea7` both in the archive and after the build, so the build does not dirty a tracked file.
- **Where reproducibility is not exact:** `bunfig.toml` sets a 7-day `minimumReleaseAge` for installs, so `bun install` of anything not pinned by `bun.lock` depends on the date it runs; with the lockfile pinned and `--frozen-lockfile` it does not. Measured: `bun install --frozen-lockfile` on a fresh archive exits 0 (0.84 s). `dist/package.json`'s `bun-pty` is a range (`^0.4.2`) with no lockfile of its own, so a `dist/`-only target would resolve it at deploy time (section 5).
- There is no `.gitattributes` (`export-ignore`/`export-subst` could change an archive), so `git archive <sha>` is the exact tree.

## 4. Build shapes, measured

All runs: bun 1.3.14, scratch clones of this repository under the delegate's scratchpad, SHA `9408c731` (the "other SHA" for warm runs is `origin/main~5`). "Cold" is a fresh directory with a **warm global bun cache** (the normal state of a host that has deployed before); one run with an empty global cache is reported separately. Times are seconds.

### 4.1 Shapes

1. **Persistent detached build worktree:** `git worktree add --detach <build> <sha>`; per deploy `git -C <build> checkout --detach <sha>` (a `fetch` first when the source is not local), untracked build output cleaned, `node_modules` kept.
2. **`git archive <sha> | tar -x`** into a fresh directory per deploy.

### 4.2 Results (three runs each; the build once per shape)

| Measurement | Runs | Median |
|---|---|---|
| Shape 2: `git archive` + extract | 0.35 / 0.23 / 0.17 | **0.23** |
| Shape 2: `bun install`, cold (fresh dir) | 1.18 / 0.72 / 0.57 | **0.72** |
| Shape 2: `bun install`, warm (second install, same dir) | 0.30 / 0.22 / 0.24 | **0.24** |
| Shape 2: `NODE_ENV=production bun run build` (once) | 26.03 | n/a |
| Shape 1 (non-bare clone): `bun install`, cold (first in the worktree) | 0.89 / 1.40 / 0.67 | **0.89** |
| Shape 1 (non-bare clone): `checkout --detach` other SHA | 0.09 x3 | 0.09 |
| Shape 1 (non-bare clone): `bun install`, warm (other SHA, `node_modules` kept) | 0.41 / 0.24 / 0.28 | **0.28** |
| Shape 1 (non-bare clone): build (once) | 25.14 | n/a |
| Shape 1 (bare clone): `git worktree add --detach` | 0.27 / 0.20 / 0.22 | 0.22 |
| Shape 1 (bare clone): `bun install` with `postinstall` on | **exit 1 x3** (section 4.3) | n/a |
| Shape 1 (bare clone): `bun install --ignore-scripts`, cold | 0.47 / 0.34 / 0.31 | 0.34 |
| Shape 1 (bare clone): `bun install --ignore-scripts`, warm (other SHA) | 0.02 x3 | 0.02 |
| Shape 1 (bare clone): build at the other SHA (once) | 22.36 | n/a |
| Cold `bun install` with an EMPTY global cache (one run) | 4.12 | n/a |

**Reading.** The install difference between the shapes is about half a second on a warm-cache host and about four seconds on an empty-cache host; the build is 22 to 26 s in every shape. Shape 2 re-pays the install on every deploy and still totals under 27 s. The persistent worktree buys almost nothing here.

### 4.3 Both shapes work on bare and non-bare repos, with one caveat that decides between them

Commands that prove the git half (scratch bare clone: `git clone --bare <repo> p0/bare.git`; `git -C p0/bare.git rev-parse --is-bare-repository` prints `true`):

```
git -C p0/bare.git archive <sha> | tar -x -C p0/arch1        # exit 0; 25 MB tree, no .git
git -C p0/bare.git worktree add --detach p0/bw1 <sha>         # exit 0; "HEAD (no branch)"
```

The caveat is in the install, not in git. Inside the linked worktree of the BARE clone, `bun install` fails in `postinstall`:

```
$ bun scripts/install-hooks.mjs
hooks:install — source missing: <scratch>/p0/scripts/git-hooks/commit-msg
error: postinstall script from "agent-console" exited with 1
```

`scripts/install-hooks.mjs:69` returns `dirname(resolve(git rev-parse --git-common-dir))` as the repository root. For a non-bare repo the common directory is `<root>/.git`, so the root is right; for a bare repo it is the bare directory itself and `dirname` is its parent, a directory that has no `scripts/`. The script treats that as a hard failure by design (`:96`). In the archive tree there is no `.git`, `git rev-parse --git-common-dir` itself fails, and the script's documented soft-fail path exits 0 (stderr warning only), which is why shape 2 passes.

Consequences beyond this review: on a bare source repository, **`bun install` fails in every linked worktree of agent-console itself** unless the script is fixed or the install runs with `--ignore-scripts`. It is a prerequisite of phases 2-3 of #919, not only of the deploy. It is filed as a phase Issue (section 7).

## 5. What to copy: whole-tree rsync or a manifest

| | Whole-tree `rsync` (today) | Explicit manifest (`dist/`, plus what section 2 finds) |
|---|---|---|
| Target size | 832 MB with its production `node_modules` (606 packages) | 25 MB with its production `node_modules` (1 package, `bun-pty`) |
| Stray files | sources, tests, docs, `.claude/`, any untracked file in the build tree | none |
| New runtime read | works by accident if the file is in the tree | must be added to the manifest, or it is missing in production |
| Install semantics | root `bun.lock`, workspace `package.json`s, root `bunfig.toml` (7-day cool-off) | `dist/package.json` only: `bun-pty` as a range, no lockfile, no `bunfig.toml` unless added to the manifest |
| Runtime result today | `/api/skills` empty, `deployedSha` and static files fine | identical on those three calls (section 2.3) |

**Recommendation: keep the whole-tree copy in phase 1; treat the manifest as a separate, later step.** Phase 1's goal is to decouple from the source working tree and pin the SHA; the manifest changes what is installed in production (606 packages to 1, lockfile and `bunfig.toml` semantics) and deserves its own decision, which is a runtime-behaviour change independent of the decoupling. The trade is stated above: a manifest gives a 25 MB target and no stray files, at the price that every new runtime read must be listed. **The test that would catch a missing entry:** the tier-3 verification (`scripts/verify-multiuser-systemd.sh`) after a manifest deploy (V4 unit active, V5 health and `/api/config.deployedSha`), plus a unit test over the manifest constant asserting it covers section 2.2's table; neither exists today because there is no manifest.

## 6. Recommendation for phase 1: a diff sketch (applied in Issue #2090)

The change to `scripts/update-and-deploy-for-multiuser-ubuntu.sh` was **owner-gated** (approved 2026-10-14) and is now applied. The sketch below is the design as proposed; the shipped script differs from it in four recorded ways:

1. **Explicit build-directory removal before V0.** The `trap` alone would leave the `0700` build directory in the data root while V0 (data-root ownership) scans it, so the script also removes it right after the rsync succeeds and clears its own state so the `trap` does not run a second time. The `trap` stays as the failure-path net.
2. **The archive pipeline runs under `bash -c` with an inner `set -o pipefail`**, not `sh -c`: without it `tar`'s exit 0 masks a failing `git archive`, and Ubuntu 22.04's `dash` (0.5.11) has no `pipefail` (0.5.12 added it).
3. **The SHA guard and the `rev-parse` default end in one error message.** A failing `rev-parse origin/main` in the default expansion would otherwise exit silently under `set -e`.
4. **`DEPLOY_SHA` is normalized to the full commit SHA after the guard** (`rev-parse "${DEPLOY_SHA}^{commit}"`), so a branch, tag or short override still yields a marker and `/api/config.deployedSha` that are full SHAs.

```diff
-DEPLOYED_SHA="$(sudo -u "${SERVICE_USER}" -- git -C "${SRC}" rev-parse HEAD)"
+# Resolved ONCE; everything below builds this exact tree.
+DEPLOY_SHA="${AGENT_CONSOLE_DEPLOY_SHA:-$(sudo -u "${SERVICE_USER}" -- git -C "${SRC}" rev-parse origin/main)}"
+sudo -u "${SERVICE_USER}" -- git -C "${SRC}" cat-file -e "${DEPLOY_SHA}^{commit}"   # fail early on an unknown SHA
+BUILD_DIR="$(sudo -u "${SERVICE_USER}" mktemp -d "${DATA_ROOT}/build.XXXXXX")"
+trap 'sudo -u "${SERVICE_USER}" rm -r -- "${BUILD_DIR}"' EXIT
+sudo -u "${SERVICE_USER}" sh -c 'git -C "$1" archive "$2" | tar -x -C "$3"' _ "${SRC}" "${DEPLOY_SHA}" "${BUILD_DIR}"
-... && cd -- "$1" && bun install                       # SRC
+... && cd -- "$1" && bun install --frozen-lockfile     # BUILD_DIR
-... && cd -- "$1" && NODE_ENV=production bun run build  # SRC
+... && cd -- "$1" && NODE_ENV=production bun run build  # BUILD_DIR
-CURRENT_SHA=... (the re-check after build)              # removed: nothing can move under an archive
-rsync ... "${SRC}/" "${DST}/"
+rsync ... "${BUILD_DIR}/" "${DST}/"
-CURRENT_SHA=... (the re-check after rsync)              # removed
-printf ... "${DEPLOYED_SHA}" ... > "${DST}/.deploy-sha"
+printf ... "${DEPLOY_SHA}" ... > "${DST}/.deploy-sha"
```

- **`SRC` becomes the build dir** for install, build and rsync; it remains the source of the SHA and of the archive only. The pre-check line becomes a print of `DEPLOY_SHA` and its subject.
- **Which re-checks become unnecessary:** both HEAD re-checks (`:298-303`, `:311-316`); a build of a fixed tree cannot be invalidated by a ref move. **Which stay:** the fail-closed unified-entry readability check, the data-root ownership check (V0), the unit-drift check (V1), and the post-restart V3-V6 screen; they verify the host, not the source.
- **`DEPLOYED_SHA` is passed in** through an explicit `AGENT_CONSOLE_DEPLOY_SHA` (preferred for a reproducible deploy) with `origin/main` of the source repository as the default; the script no longer asks the operator to sync a working tree first.
- **The operator procedure** replaces `docs/multi-user-setup-guide.md:582-586` ("sync the source-repo ... to the intended commit before invoking"): `git -C ${DATA_ROOT}/source-repos/agent-console fetch origin`, then run the script (optionally with `AGENT_CONSOLE_DEPLOY_SHA=<sha>`); the printed `DEPLOY_SHA` line replaces the printed HEAD line.
- **`bun install --frozen-lockfile`** (measured to work, section 3) is part of the sketch because it is what makes the install a function of the SHA.
- **Verification that proves it, and the V-check that would catch a wrong SHA:** the tier-3 run (`scripts/verify-multiuser-systemd.sh`, in the container) deploys a known SHA; **V5's `/api/config.deployedSha` is compared with the requested SHA**, and a mismatch is the failure. The comparison must be against the REQUESTED SHA, not against the marker file the deploy itself wrote (that would pass for any tree), so the verification receives the requested SHA explicitly.
- Shape 2 (`git archive`) is recommended over shape 1 for the reasons in section 4; the build directory is per deploy and removed by the `trap`. If a later measurement on a slower host shows the install dominating, shape 1 can be reconsidered for a NON-bare source repo only (section 4.3).

## 7. Phase Issues to file (text ready to paste)

Each carries `Refs #919` and names its gate.

1. **Phase 1 -- deploy from a pinned SHA (owner-gated: deploy script).** Implement section 6 in `scripts/update-and-deploy-for-multiuser-ubuntu.sh`: `git archive` of `AGENT_CONSOLE_DEPLOY_SHA` (default `origin/main`) into a per-deploy build directory, `bun install --frozen-lockfile`, build, rsync from the build directory, marker from the requested SHA, remove both HEAD re-checks, update `docs/multi-user-setup-guide.md:582-586`. Verification: tier-3 (`scripts/verify-multiuser-systemd.sh`) with V5 compared against the requested SHA. Do not change what is copied (whole tree) in this phase. Gate: owner Y on the script change.
2. **Phase 1a -- `install-hooks.mjs` on a bare repository.** `resolveRepoRoot()` (`scripts/install-hooks.mjs:69`) must not derive the root from `dirname(git-common-dir)` for a bare repository; resolve the hooks source relative to the script's own location instead, and make `bun install` succeed in a linked worktree of a bare repo. Test: a scratch bare clone with a linked worktree, `bun install` exits 0 (polarity: exit 1 today). A prerequisite of phases 2-3. Gate: none (scripts, additive).
3. **Phase 2 -- bare for NEW clones only.** Clone service `--bare` + `remote.origin.fetch` + one fetch; `registerRepository` and `applyMultiUserSharedRepoConfig` on a bare path (`source-repo-storage-model.md` section 10 items 1-2). No migration; existing repositories stay non-bare. Gate: none beyond review (depends on phase 1a).
4. **Phase 3 -- main-worktree rule and source-reading features** (section 10 items 3-4). Gate: owner decision (i)/(ii) asked at the start of the phase, with the End Session work already landed.
5. **Phase 4 -- conversion of existing repositories, Orchestrator procedure, real-host verification** (section 10 items 5, 7, 8). Gate: migration option decided at the start of the phase (owner).
6. **Optional -- deploy copy manifest.** Replace the whole-tree rsync with an explicit manifest (section 5), after deciding the `bun-pty` lock and `bunfig.toml` semantics. Gate: owner (changes what is installed in production).
