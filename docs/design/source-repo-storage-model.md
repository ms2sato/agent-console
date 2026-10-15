# Source Repository Storage Model: Bare Source Repos

Status: design proposal, staged. **Owner direction (2026-10-14, Issue [#919](https://github.com/ms2sato/agent-console/issues/919)): bare and non-bare source repositories are both supported permanently, side by side; nothing converts existing repositories.** Consequences recorded below: section 6 (phase 1, the deploy build) is applied by PR [#2115](https://github.com/ms2sato/agent-console/pull/2115); section 7 (conversion sequence) and section 10 item 5 are not pursued; the section 11 migration decision is moot. The measurements in those sections are kept as evidence. The main-worktree rule (section 5) is decided: option (ii), 2026-10-15. Phase 3 lands in two PRs: PR-A (server-side reading and gating, no wire change) and PR-B (the clone checkbox, a schema move).

This document decides whether a [Source Repository](../glossary.md#source-repository) should keep a checked-out working tree, how existing ones would be converted, and what the conversion costs. It is written from the code at `main` and from measurements on a scratch clone, not from the Issue text. Every "bare-safe" claim below names the line it was checked against or the command that was run.

## 1. Problem

On 2026-06-29 a source repository on the dogfood host ended up with a branch ref and a working tree that disagreed. A low-level ref update (the shape of `git fetch origin main:main`) moved `refs/heads/main` to a new commit while the index and the working tree stayed at the old one. `git status` then reported the whole difference as a large staged diff, and recovery needed a hard reset. The owner decided on 2026-06-29 to move source repositories to a bare layout so this class of drift cannot occur.

What a working tree at the source-repo path is used for today:

- **Users: nothing.** Every user action goes through a linked worktree under `<AGENT_CONSOLE_HOME>/repositories/<org>/<repo>/worktrees/`. The one exception is the dashboard's *main worktree* entry, which opens a session directly on the source path (section 5).
- **The deploy script: build and rsync.** `scripts/update-and-deploy-for-multiuser-ubuntu.sh` ran `bun install` and `bun run build` inside the source-repo working tree and then rsynced that tree to the deploy target (section 6); since PR #2115 it builds a pinned SHA from `git archive` instead.
- **The Orchestrator: a ref update by hand.** The "sync the source repo to `origin/main` before delegating" step is done as a `git fetch origin main:main`-shaped operation, which is exactly the operation that produced the drift.

Keeping a working tree that nobody edits, next to refs that are updated out of band, is the structural cause. A bare repository has no index and no working tree to disagree with.

## 2. Model

A bare source repository holds objects and refs only. Branches are checked out in linked worktrees, which is the layout git documents for `git worktree`. Three consequences, each measured on a scratch clone (commands in section 3):

- **Detection** is `git rev-parse --is-bare-repository` (prints `true` / `false`).
- **`HEAD`** of the bare repo is a symbolic ref to the default branch (`refs/heads/main` after a bare clone). It is not "checked out" anywhere, so a linked worktree may check out `main` (measured: `git worktree add ../main main` exits 0).
- **`git worktree list --porcelain`** lists the bare directory as the *first* entry with a lone `bare` line and no `HEAD` or `branch` line, followed by the linked worktrees. `git worktree add` and `git worktree prune` run with the bare directory as cwd (the three `lib/git.ts` call sites: `listWorktrees` at `:426`, `removeWorktreeWithFallback` at `:452-475`, and `WorktreeService.invokeGitWorktreeAdd` at `worktree-service.ts:612-635`) and behave as for a non-bare repo.

The registered `repo.path` does not change: the bare repository lives at the same path the non-bare one did. No `.git` suffix is added to the directory name, because `deriveRepositorySlug(repo.path, path.basename(repo.path))` and `getRepositoryDir(orgRepo)` key on the basename, and because a stable path keeps the stored `Repository.path`, `safe.directory` entries and session `locationPath` values valid (identity stability).

**Scope: only repositories under the source-repos directory are in the model.** `registerRepository` accepts any local git checkout by path (`repository-manager.ts:318-346`), for example an operator's own working copy outside `getSourceReposDir()`. Those are the operator's checkouts and must never be converted. `isUnderSourceReposDir` (`lib/repository-remote.ts:36`) is the boundary. Consequence: bare and non-bare repositories coexist permanently, whichever migration option is chosen (section 7). The owner direction of 2026-10-14 makes this the goal rather than a side effect: bare is an additional supported shape, and later phases are designed under the constraint that an existing non-bare repository keeps working unchanged.

## 3. Measurements (scratch clone, git on the dogfood host)

All run against a local scratch upstream with `GIT_CONFIG_GLOBAL=/dev/null` so the operator's gitconfig does not interfere. Paths shortened.

**3.1 `git clone --bare` writes no tracking configuration.**

```
git clone --bare up b
git -C b config --list --local      -> core.bare=true, remote.origin.url=<up>      (no remote.origin.fetch)
git -C b for-each-ref               -> refs/heads/feat, refs/heads/main            (no refs/remotes/origin/*)
git -C b branch -r                  -> (empty)                 non-bare clone: origin/HEAD, origin/feat, origin/main
git -C b symbolic-ref refs/remotes/origin/HEAD   -> fatal: ref refs/remotes/origin/HEAD is not a symbolic ref
git -C b remote set-head origin -a  -> error: Not a valid ref: refs/remotes/origin/main     (rc 1)
```

After `git -C b config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'` and one `git -C b fetch origin`:

```
git -C b branch -r                  -> origin/feat, origin/main
git -C b remote set-head origin -a  -> origin/HEAD set to main                              (rc 0)
git -C b symbolic-ref refs/remotes/origin/HEAD   -> refs/remotes/origin/main
```

Without the refspec, `git -C b fetch origin main` only writes `FETCH_HEAD` (`git branch -r | wc -l` stays 0), so `origin/<branch>` never moves.

**3.2 A bare repo has no working tree for pull.** `git -C b pull --ff-only` -> `fatal: this operation must be run in a work tree`.

**3.3 `git clone --bare` does not carry linked-worktree registrations** (relevant to migration, section 7). A non-bare repo with two linked worktrees reported 3 entries from `worktree list`; `git clone --bare` of it reported 1, kept no `remote.origin.fetch`, set `remote.origin.url` to the *old local path* instead of the real upstream, and dropped local config (`core.sharedRepository`, user settings). After swapping the directories in, the linked worktrees' `.git` files still pointed at `<old>/.git/worktrees/<name>`, and `git -C <new> worktree repair <wt-paths>` failed for both with `error: unable to locate repository; .git file does not reference a repository`, because the new repository has no administrative directory for them to be repaired against.

**3.4 Moving the git directory in place keeps everything.** With `mv old/.git old.gitdir`, `git -C old.gitdir config core.bare true`, `mv old old.checkout-aside`, `mv old.gitdir old`: `rev-parse --is-bare-repository` -> `true`; `for-each-ref` output identical to the pre-conversion snapshot; `remote.origin.*`, `branch.*` config and remote-tracking refs retained; the linked worktrees were reported broken (`fatal: not a git repository: <old>/.git/worktrees/wtA`) until `git -C old worktree repair ../wtA ../wtB` (explicit worktree paths) printed `repair: .git file broken: <wtB>` / `<wtA>` and fixed them; afterwards `wtA/.git` read `gitdir: <old>/worktrees/wtA`, `git -C wtA status -sb` worked and `worktree list` reported 3 entries.

**3.5 The default branch in a linked worktree, and the Orchestrator's sync.** After `git -C old worktree add ../main main` (exit 0):

```
git -C old fetch origin main:main
  -> fatal: refusing to fetch into branch 'refs/heads/main' checked out at '<...>/main'     (rc 128)
git -C old fetch origin                       -> origin/main advances; refs/heads/main stays
git -C main merge --ff-only origin/main       -> refs/heads/main advances; `git -C old rev-parse HEAD` follows
git -C old archive --format=tar HEAD | wc -c  -> 10240
```

So the drift incident's operation is *refused* by git as soon as the branch is checked out in a worktree, instead of silently diverging. It also means the Orchestrator's by-hand `fetch origin main:main` step stops working under main-worktree option (i) below and is replaced by `fetch origin` plus a fast-forward in the main worktree (a breaking change to that procedure, listed in section 8).

**3.6 `gh` works inside a bare repo.** With `remote.origin.url` set to this project's GitHub URL: `gh pr list --limit 1 --json number` returned a number and `gh api repos/{owner}/{repo}` resolved the placeholders (`ms2sato/agent-console`) from the bare repo's remote.

## 4. Code impact

Population: `grep -rn "repo\.path\|repository\.path\|repo?\.path\|repository?\.path" packages/server/src` excluding tests, plus the helpers those call sites reach. "Bare-safe" means checked against the helper's git invocation in section 3; rows marked *after refspec* are bare-safe only once the clone or migration has set `remote.origin.fetch` and fetched once (3.1).

| Site (line) | What it does with the path | Class |
|---|---|---|
| `routes/repositories.ts:367` -> `worktree-service.ts:987` `listBranches` -> `lib/git.ts:303-333` | `branch --format`, `branch -r --format`, default-branch probe | bare-safe *after refspec* (`branch -r` is empty without it, 3.1) |
| `routes/repositories.ts:385` -> `lib/git.ts:388` `refreshDefaultBranch` | `remote set-head origin -a` | **needs change**: rc 1 without the refspec (3.1); bare-safe after; **Done in phase 2 ([#2099](https://github.com/ms2sato/agent-console/pull/2099))** |
| `lib/git.ts:353` `getDefaultBranch` (callers `repositories.ts:367`, `worktrees.ts:169/174`, `mcp-server.ts:1335`) | `symbolic-ref refs/remotes/origin/HEAD`, then `main` / `master` probe | bare-safe (the probe fallback survives without the refspec; correct default only after `set-head`) |
| `routes/repositories.ts:412` -> `lib/git.ts:872` `fetchRemote`; `worktree-creation-service.ts:169` | `git fetch origin <branch>` | **needs change**: only `FETCH_HEAD` moves without the refspec (3.1); bare-safe after; **Done in phase 2 ([#2099](https://github.com/ms2sato/agent-console/pull/2099))** |
| `routes/repositories.ts:416-417` -> `lib/git.ts:896/909` `getCommitsBehind` / `getCommitsAhead` | `rev-list --count <b>..origin/<b>` | **needs change**: `origin/<b>` does not exist without the refspec, the `catch` returns 0 (silent wrong answer); bare-safe after; **Done in phase 2 ([#2099](https://github.com/ms2sato/agent-console/pull/2099))** |
| `routes/repositories.ts:443` -> `lib/git.ts:885` `fetchAllRemote` | `git fetch origin` | bare-safe after refspec (fetches nothing useful before) |
| `repository-clone-service.ts` `buildCloneCommand` | `git clone --config core.sharedRepository=group <url> <target>` via `runAsUser` (`command: 'sh -s'`, the chain on `stdin`) | **applied** (PR-B): `buildCloneCommand` emits `git clone --bare` with the refspec set at clone time plus `remote set-head origin -a`; no separate fetch (see section 10 item 1) |
| `repository-manager.ts:334-340` `registerRepository` | `access(<path>/.git)` -> "Not a git repository" | **needs change**: a bare repo has no `.git` entry; accept `rev-parse --git-dir` / `--is-bare-repository` instead; **Done in phase 2 ([#2099](https://github.com/ms2sato/agent-console/pull/2099))** |
| `repository-manager.ts:69-71`, `:604-660` `applyMultiUserSharedRepoConfig`; `lib/git-error-hints.ts:22` | `chmod` / `chgrp` / probe on `<path>/.git`, hint text names `<path>/.git` | **needs change**: the git directory *is* the repo root on a bare repo; **Done in phase 2 ([#2099](https://github.com/ms2sato/agent-console/pull/2099))** |
| `worktree-service.ts:437` `parsePorcelainOutput` | first `worktree list` entry is `isMain` | **needs change**: the first entry is the bare directory (no branch). New rule in section 5; **Done in phase 2 ([#2099](https://github.com/ms2sato/agent-console/pull/2099))** |
| `worktree-service.ts:1039-1046` `isWorktreeOf`; `routes/worktrees.ts:265-279`; `worktree-deletion-service.ts:344` | `worktreePath === repoPath` means "main worktree, always valid" | **needs change** with section 5 (the path comparison no longer identifies the main worktree); **Done in phase 3 (PR-A of Issue #2093)**: on a bare repository the repo path is never a worktree of itself, and the pull route sends it through the boundary and ownership checks |
| `session-converter-service.ts:206`, `:300` | `isMainWorktree: repository?.path === session.locationPath` | unchanged under option (ii): no session can be located at a bare repository path, so the field is `false` on bare (the wire field is kept) |
| `worktree-deletion-service.ts:210`, `:357` | refuses to delete a session flagged `isMainWorktree` | unaffected by the model; depends on the section 5 rule |
| `worktree-service.ts:111-120` `findTemplatesDir` (called at `:564`) | reads `<repoPath>/.agent-console/` from the working tree | **needs change**: silently falls back to the global templates directory on a bare repo; read the templates from the default branch (`git show` / `git archive`) or from the main worktree; **Done in phase 3 (PR-A of Issue #2093)**: exported with `git archive` at the source read ref into a temp directory that is removed afterwards |
| `services/repository-description-generator.ts:42-50`, `:111`, `:123` (via `routes/repositories.ts:302`) | reads `README*` from the path; runs the agent with `cwd = repositoryPath` | **needs change**: no README on a bare path; read it from the default branch or the main worktree; **README read Done in phase 3 (PR-A of Issue #2093)** through `git show` at the source read ref; the agent's `cwd` is unchanged (see the note below the table) |
| `services/session-metadata-suggester.ts:63`, `:132`, `:146` (via `mcp-server.ts:1316`, `worktrees.ts:153`) | `branch -a --list`; runs the headless agent with `cwd = repositoryPath` | `branch -a` bare-safe after refspec; the headless agent keeps `cwd = repo.path` on a bare repository (recorded limit, see the note below the table) |
| `worktree-service.ts:312-335` `ensureRepoHasCommits` | `rev-list --all --count` | bare-safe (counts refs, no tree needed) |
| `worktree-service.ts:276`, `:343-345` `verifyRepoAccessible`, `listWorktrees` | `worktree list --porcelain` | bare-safe for the command; the parse is the `:437` row |
| `worktree-service.ts:477-640` `createWorktree` (`invokeGitWorktreeAdd`) | `git worktree add` with cwd = repo path | bare-safe (3.4 / 3.5 ran it); permissions: section 8 |
| `worktree-service.ts:768-880` `removeWorktree`, `mcp-server.ts:1384`, `worktree-deletion-service.ts:438` | `fs.stat(repoPath)`, `git worktree remove` with cwd = repo path | bare-safe (`worktree remove` and `prune` do not need a working tree) |
| `worktree-deletion-service.ts:386` `findOpenPullRequest`; `routes/repositories.ts:338` `fetchGitHubIssue` | `gh` with cwd = repo path | bare-safe (3.6) |
| `routes/repositories.ts:117`, `mcp-server.ts:552`, `inbound/resolve-targets.ts:78/181`, `repository-manager.ts:860/942`, `lib/repository-remote.ts:71`, `database/connection.ts:3450` | `git remote get-url origin` (`getRemoteUrl`, `getOrgRepoFromPath`, `deriveRepositorySlug`) | bare-safe (config read; `remote.origin.url` is present in a bare clone, 3.1) |
| `routes/worktrees.ts:47`, `worktree-deletion-service.ts:85` | `listWorktrees(repo.path, id)` | the `:437` row |
| `repository-manager.ts:309`, `:347`, `lib/repository-path-status.ts` (`classifyRepositoryPath`) | `existsSync`, canonical path compare, `R_OK | X_OK` on the directory | unaffected |
| `repository-manager.ts:445-446`, `:837-894`; `lib/repository-remote.ts:36`; `jobs/handlers.ts:127` | path containment for the cleanup job's `extraDir` removal | unaffected |
| `database/mappers.ts:466`, `:504` | maps the stored path | unaffected |
| `services/branch-watcher-service.ts:44-66` `resolveHeadFilePath` | reads `<locationPath>/.git` as a file (`gitdir:` pointer) or directory | bare-safe for linked worktrees (resolves the pointer to `<bare>/worktrees/<name>/HEAD`); a session on the bare path would get `null`, which is why sessions cannot live there (section 5) |
| `routes/worktrees.ts:351` `pullFastForward` | `git pull --ff-only` with cwd = a **worktree** path | unaffected (never the source path); it is the only helper that needs a working tree |
| `lib/git.ts:823` `isWorkingDirectoryClean`, `:647` `getStatusPorcelain`, `:601` `getUntrackedFiles`, diff helpers | run with a worktree cwd | unaffected |

**Object-store reads (phase 3).** On a bare repository the server reads source files through git, never from the path: `resolveSourceReadRef` returns `origin/<default branch>` once the fetch refspec is present (a bare clone's local `<default>` branch stays at clone time because `fetch origin` only updates `refs/remotes/origin/*`) and `HEAD` otherwise. `readRepoFileAtRef` and `exportRepoTreeAtRef` (`lib/git.ts`) are the two readers; the README and the `.agent-console/` templates are the only server reads of `repo.path` that need them. Template entries that are symlinks are skipped on both arms (the reader is the server process). Template reads: symlinks are skipped both by the directory-entry type and by `O_NOFOLLOW` on the file open; a directory swapped for a symlink between the parent's listing and the child's listing is not defended (`O_NOFOLLOW` governs only the final path component and Bun exposes no descriptor-relative open) -- revisit when Bun exposes descriptor-relative opens, or on any report. The export is capped at `MAX_TEMPLATE_ARCHIVE_BYTES` (16 MiB); a larger archive is a loud failure. The reads see the repository as of its last `fetch origin`, not the remote's current tip. `session-metadata-suggester.ts:132/146` keeps running the headless agent with `cwd = repo.path` on a bare repository (a recorded limit, class 4): the agent is started in a directory with no working tree, and whether that is acceptable to a given agent CLI has not been verified on a real host.

Non-server sites: `scripts/update-and-deploy-for-multiuser-ubuntu.sh` (section 6), `scripts/setup-multiuser-for-ubuntu.sh` (creates the source-repos directory only; no git operations on repos), `docs/multi-user-setup-guide.md` ("Source Repo Group-Writability" commands name `<repo-path>/.git`; the deploy section tells the operator to sync `source-repos/agent-console` before deploying), and the Orchestrator's by-hand sync step (3.5).

## 5. The main-worktree session

**Decided (owner, 2026-10-15): option (ii), for bare repositories only.** Bare and non-bare repositories coexist permanently, so a non-bare repository keeps its main worktree row and its main-worktree sessions unchanged; the rule below concerns what a bare repository does. The `isMainWorktree` field on the session wire type is **kept** and stays `false` on a bare repository (no removal, no schema move); the bare directory is refused as a session location. Option (i) is kept below as the alternative that was not chosen.

**Phase 2:** the server accepts an existing bare source repository, and `parsePorcelainOutput` skips the bare entry so no row is `isMain` on a bare repository; the dashboard therefore shows no "main" row for it.

**Phase 3, PR-A (applied):** the bare directory is never a worktree of itself (`isWorktreeOf`), the pull route sends it through the boundary and ownership checks and refuses it, and session creation refuses a worktree session whose location is a bare repository's own path (400, "a bare source repository has no working tree; open a session on a worktree"). **PR-B (upcoming):** the clone form gains an opt-in "Bare repository" checkbox, which is the only schema change of the phase.

The dashboard shows one *main worktree* entry per repository and lets the user open a session on it. In code, "main worktree" means two things that coincide only on a non-bare repo: the **first entry** of `git worktree list` (`parsePorcelainOutput`, `worktree-service.ts:437`) and the **registered path** itself (`session-converter-service.ts:206/300` compares `repository.path` with `session.locationPath`; `routes/worktrees.ts:265-279` and `isWorktreeOf` treat the repo path as always valid). Consumers: `client/src/routes/index.tsx:932/1013/1076` (`worktree.isMain` hides the delete action and marks the row), `components/SessionSettings.tsx` and `SessionSettingsMenu.tsx:203` (`isMainWorktree` hides the delete-worktree menu item), `worktree-deletion-service.ts:210/357` (refuses to delete the main worktree's sessions).

On a bare repo the first entry is the bare directory itself: no branch, nothing a session could run in (measured, section 2). Left alone, the dashboard would show a branchless "main" row.

**Option (i) — not chosen: the default branch gets a regular linked worktree.** At registration of a cloned repo and at migration, run `git worktree add <worktrees>/main <default-branch>` (`<worktrees>` is the existing `<AGENT_CONSOLE_HOME>/repositories/<org>/<repo>/worktrees/`). `isMain` becomes "the worktree whose branch is the default branch", replacing "the first list entry" (`worktree-service.ts:437`), and the `repository.path === locationPath` comparisons move to the same rule. The bare entry is skipped by the parser. Reasons:

- it is the model git documents for bare repos with worktrees: the bare directory holds objects and refs; `main` is checked out like any other branch;
- the dashboard, `isMainWorktree`, delete protection and the pull-main UX (`docs/design/main-branch-pull-ux.md`, `pullFastForward` on a worktree path) keep their meaning with only the identification rule changed;
- it composes with the End Session proposal (proposal A): ending a session on the main worktree is then an ordinary worktree-session end and the directory stays, as that proposal already specifies;
- git itself refuses a ref update under the checked-out branch (3.5), which is the drift incident's guard.

The cost: a working tree exists again, at `<worktrees>/main`. It is a normal worktree, not the source of truth for refs, and the destructive operation from the incident cannot be applied to it behind git's back.

**Option (ii) — chosen: a bare repository has no main-worktree session.** On a bare repository, sessions exist only on linked worktrees; the bare entry is skipped from the list, so the dashboard has no main row for it, and the main-branch pull action is not offered for its path. As decided, this does **not** remove the `isMainWorktree` wire field (`packages/shared/src/types/session.ts:71`, `schemas/app-server-message.ts:113`) or the client code keyed on it (`SessionSettings`, `SessionSettingsMenu`, the deletion guards at `worktree-deletion-service.ts:210/357`): the field simply stays `false` for every session on a bare repository, because no session can be located at the repository path, so there is no schema change and no `SCHEMA_VERSION` move. The bare directory is refused as a session location on the server (session creation) and as a pull target.

This decision is independent of the End Session proposal's pending approval; that proposal's state table applies to option (i) unchanged. Migration under (i) adds one step after the bare conversion (section 7).

## 6. Deploy impact (owner-gated)

**Status: phase 1 applied by PR [#2115](https://github.com/ms2sato/agent-console/pull/2115) (Issue #2090, merged 2026-10-14; owner approval 2026-10-14).** The deploy script now resolves `DEPLOY_SHA` (`AGENT_CONSOLE_DEPLOY_SHA`, default `origin/main`) and builds from `git archive` of that SHA into a per-deploy build directory, which is shape 2 below as revised by Phase 0. The line numbers in the bullets that follow describe the script as it was BEFORE that PR and are kept as the measured evidence; the current anchors, re-read at `82a7d062`, are: `SRC` at `:126`, `DEPLOY_SHA` resolution at `:288` and `:298`, the build directory at `:310`, `git archive` at `:320-324`, `bun install` at `:327-330`, the build at `:334-337`, and the rsync at `:341-345`. `docs/multi-user-setup-guide.md` (deploy section, around `:582`) now says the script builds from a pinned commit and tells the operator to `fetch origin` first. What this section's last paragraph calls the Orchestrator's sync step is not part of that PR: see section 10 item 7.

`scripts/update-and-deploy-for-multiuser-ubuntu.sh` is the one real breaking change, and any edit to it is **owner-gated**.

- `:118` sets `SRC` to the source repository (`source-repos/agent-console` by default, or `AGENT_CONSOLE_APP_SOURCE_DIR`).
- `:276`, `:282`, `:298`, `:311` read `git -C "$SRC" log` / `rev-parse HEAD`: ref-only, fine on a bare repo (`HEAD` follows `refs/heads/main`, 3.5).
- `:285-296` run `bun install` and `NODE_ENV=production bun run build` **in** `$SRC`, and `:306-309` rsync `$SRC/` to the deploy target. On a bare repo there is nothing to build or copy; `package.json` does not exist there.

Two replacement shapes:

1. **A dedicated build worktree**: a persistent detached worktree of the bare repo (for example under `${DATA_ROOT}/build/`), refreshed per deploy with `git -C <build> checkout --detach <sha>`, then `bun install`, build and rsync from it.
2. **`git archive <sha> | tar -x` into a fresh temporary directory**, then install, build and rsync from there. Measured: `git archive` works on the bare repo (3.5).

Both pin an explicit SHA, so `DEPLOYED_SHA` (`:282`) stays reproducible and the "HEAD changed during build / during deploy" re-checks (`:298-:311`) stop being load-bearing: a build of a fixed SHA cannot be invalidated by a concurrent ref move. **Recommendation: shape 1.** Today's deploy reuses `node_modules` in the source tree between deploys; a persistent build worktree keeps that, whereas shape 2 reinstalls every time. Shape 2 is simpler and stateless; choose it if the owner prefers no persistent build state. The trade is stated, not timed: no install-time measurement was taken. The build worktree must be cleaned of untracked build output (but not `node_modules`) before each build, and a crashed deploy can leave a stale administrative entry that `git worktree prune` removes.

`docs/multi-user-setup-guide.md` ("sync the source-repo ... to the intended commit before invoking") needed the same update (done by PR #2115: it now describes the pinned-commit build), and so does the Orchestrator's sync step (3.5), which remains open as section 10 item 7.

Phase 0 of the staged plan measured these build shapes and reviewed the whole deploy flow: see [deploy-build-flow.md](deploy-build-flow.md). Its measurements (install is under a second; the build is 22 to 26 s) change the recommendation above in favour of `git archive` of a pinned SHA into a per-deploy build directory, and it found that a persistent worktree of a bare repo cannot run `bun install` today (`scripts/install-hooks.mjs:69`).

## 7. Migration strategy

**Not pursued (owner, 2026-10-14: bare and non-bare coexist permanently; no conversion).** Nothing below is scheduled. The options, the conversion sequence, the crash points and their measurements are kept as the record of why conversion was costed and then dropped, and as a starting point if the direction is ever reversed; do not implement them without a new owner decision.

The Issue's three options, evaluated against measurements. The columns the decision turns on:

| | 1. Bare by default + automatic conversion | 2. Bare by default + operator script, sunset | 3. Hybrid (checkbox) |
|---|---|---|---|
| Operator steps | none | run the script once per source repo | choose per clone |
| Failure modes | a half-converted repo if interrupted; a repo with a live session on the main worktree; a dirty working tree | same hazards, but an operator is present to react | two storage models forever |
| Test matrix | bare and non-bare (registered local checkouts never convert) | bare and non-bare until the sunset | bare and non-bare permanently, by design |
| Rollback | section 9 | section 9 | n/a |

Because registered local checkouts outside the source-repos directory are never converted (section 2), a non-bare repository stays supported under *every* option, so options 1 and 2 shrink the matrix only for cloned repos. Option 3 is not recommended: it makes the divergent setup a user choice.

**Recommendation: option 1, on condition that the conversion is crash-safe and idempotent; otherwise option 2.** The sequence below meets that condition by using only atomic same-filesystem renames and a re-runnable repair; it rests on measurement 3.4. The alternative sequence of `git clone --bare <old> <tmp>`, verification and a swap was measured and **rejected** (3.3): it loses the linked-worktree registrations, so the worktrees cannot be repaired afterwards, and it also needs the remote URL and refspec re-set by hand.

**Conversion (per repo under the source-repos directory), under the repository lock:**

0. **Preconditions** — abort with no change and a logged reason if any fails: `git rev-parse --is-bare-repository` is `false`; the path is under `getSourceReposDir()`; no persisted or active session has `locationPath` equal to the repo path (under option (i) the main-worktree session must be ended first, which is where the End Session proposal helps); `git status --porcelain` is empty and there is no in-progress merge, rebase or `.git/*.lock`.
1. Write an intent marker next to the repo (outside it, for example `<name>.bare-migration` in the source-repos directory) holding the ref snapshot `git for-each-ref --format='%(refname) %(objectname)'` and the list of registered worktree paths.
2. `mv <repo>/.git <repo>.gitdir-tmp` (atomic rename).
3. `git -C <repo>.gitdir-tmp config core.bare true`; ensure `remote.origin.fetch` is set to `+refs/heads/*:refs/remotes/origin/*` (already present for clones made by the current clone service, which are non-bare clones).
4. Verify: `for-each-ref` equals the snapshot; `rev-parse --is-bare-repository` is `true`.
5. `mv <repo> <repo>.checkout-aside` then `mv <repo>.gitdir-tmp <repo>` (two atomic renames).
6. `git -C <repo> worktree repair <every worktree path in the marker>`. **`git worktree repair` with explicit paths is what repoints the linked worktrees' `.git` files** (3.4); it is idempotent. Verify `git worktree list --porcelain` reports the same number of worktrees as before, and `git -C <wt> rev-parse --git-dir` resolves for each.
7. Option (i): `git -C <repo> worktree add <worktrees>/main <default-branch>`.
8. Delete `<repo>.checkout-aside` and the marker (the old working tree, including any ignored files, is intentionally discarded). Keeping the aside directory until the next successful boot is an acceptable variant; it is the rollback source.

**Crash points** (recovery re-reads the marker on the next boot): *after 2, before 5* — `<repo>/.git` is missing and `<repo>.gitdir-tmp` exists: roll back with `mv <repo>.gitdir-tmp <repo>/.git` and `git config core.bare false`, or roll forward from step 3; *after 5, before 6* — `<repo>` is bare, worktrees are broken: run step 6 onward (idempotent); *after 6* — remaining steps are individually idempotent. Every step is keyed on the marker, so a second run after any crash converges.

The detection is `git rev-parse --is-bare-repository`, so already-converted repos are skipped, and a repo registered after the clone service switches to `--bare` is bare from the start.

## 8. Multi-user mode

`getSourceReposDir()` (`lib/config.ts:62`) documents the `2775` setgid directory, owned by the service user and the shared group, that any group member may clone into; `repository-clone-service.ts:488` passes `--config core.sharedRepository=group`. A bare repo's objects and refs are written by `git worktree add` as the **requesting** user (`repository-manager.ts:353`, `:606`), exactly as for a non-bare repo today: the administrative directory `<bare>/worktrees/<name>` and the refs it touches must be group-writable.

- `applyMultiUserSharedRepoConfig` and the manual commands in the setup guide operate on `<path>/.git`; on a bare repo the same operations apply to `<path>` itself (the table row in section 4). The rename-based conversion keeps the former `.git` directory's mode, group and setgid bits, which `applyMultiUserSharedRepoConfig` already established.
- `safe.directory` entries are keyed on the repo path, which does not change.
- **Who owns a cloned repository.** A source repository cloned from the clone form is owned by the user who cloned it, top directory included: the target directory is reserved by a plain `mkdir` run as the requesting user (so for a bare clone, where that directory IS the git dir, the requesting user's later git calls pass git's ownership check). `applyMultiUserSharedRepoConfig` runs as the server (username null), so its `chmod`/`chgrp` on a user-owned tree fail warn-only; group-writability of a user-cloned repository comes from `core.sharedRepository=group` at clone time (git's own shared permissions) and the group from the `2775` parent's setgid. Consequently `source-repos` must be group-writable (`2775`, group `agent-console-users`): the reservation fails first, before any clone, on a host where it is not, and the setup script is the single writer of that layout.
- **Not measured here:** group-write behaviour of a freshly created bare repo, and `worktree add` as a second OS user against it, were not exercised on a multi-user host. The implementation Issues must include the real-host (tier 2) verification described in `.claude/rules/os-environment-coupling.md` before they close.

## 9. Rollback

To get a working tree back for a converted repo: `git -C <repo> worktree add <path> <default-branch>` is sufficient for day-to-day use (it is what option (i) does at `<worktrees>/main`). To restore the original non-bare layout at the same path: `git -C <repo> config core.bare false`, move the repo directory's contents into `<repo>/.git`, check out the default branch into `<repo>`, and run `git worktree repair` for the linked worktrees; or restore `<repo>.checkout-aside` if it was kept (step 8). Because the registered path never changed, no database change is involved in either direction.

## 10. Implementation Issues to file (from the merged doc)

1. **Clone service: `--bare` plus tracking setup.** **Applied** by phase 3 PR-B (Issue #2093) as an opt-in `bare` request field (client checkbox, default off). `buildCloneCommand` (`repository-clone-service.ts`) emits one single-line command: `git clone --bare` with `core.sharedRepository=group` and the `remote.origin.fetch` refspec set at clone time, then `remote set-head origin -a`; the service delivers it to `runAsUser` as `command: 'sh -s'` with the string on `stdin` (the elevated login shell would otherwise expand the chain's own `$origin_refs` before it is assigned); any non-zero exit fails the job and the partial directory is removed. The `set-head` step is skipped when the clone has no remote-tracking refs (an empty upstream), so an empty repository registers exactly as a non-bare clone does and becomes usable after its first push and fetch; worktree creation refuses it with the existing empty-repository error until then; the directory name has no `.git` suffix. Polarity test: a plain bare clone (no refspec) makes `refreshDefaultBranch` fail with rc 1 (3.1). Measured with git 2.43: a refspec given at clone time makes the clone itself write the `origin/*` tracking refs, so no separate `fetch` is run; `set-head` is what adds `origin/HEAD`.
2. **Registration and multi-user config for bare paths.** `registerRepository` accepts a bare repo; `applyMultiUserSharedRepoConfig` and `git-error-hints.ts` address the git directory correctly.
3. **Main-worktree rule (section 5, decided: option (ii)).** `parsePorcelainOutput` skips the bare entry; `isWorktreeOf`, the pull route and session creation refuse the bare directory. **Applied** by phase 3 PR-A (Issue #2093).
4. **Source-reading features.** `findTemplatesDir` and the repository-description README read from the default branch through git. **Applied** by phase 3 PR-A (Issue #2093); the headless-agent `cwd` is left at `repo.path` (recorded limit, section 4).
5. **Automatic conversion** following the section 7 sequence, with the marker and crash-recovery tests. **Not pursued** (owner, 2026-10-14: bare and non-bare coexist permanently; no conversion).
6. **Deploy script: build worktree or `git archive`** (owner-gated), plus the setup-guide deploy paragraph. **Applied** by PR #2115 (`git archive` of a pinned SHA; see section 6).
7. **Orchestrator procedure and docs**: replace the by-hand `fetch origin main:main` sync with `fetch origin` plus a fast-forward in the main worktree. Tracked by Issue #2094, whose scope is narrowed to items 7 and 8 (for bare-cloned repositories only; the non-bare procedure is unchanged).
8. **Multi-user real-host verification** of group-write behaviour on a bare repo (tier 2), with a non-bare control in the same run. Tracked by Issue #2094.

## 11. Owner decisions

- **Main-worktree session**: decided (owner, 2026-10-15): option (ii), section 5. The `isMainWorktree` wire field is kept and is `false` on bare; the bare directory is refused as a session location.
- **Deploy build shape**: decided and applied: `git archive` of a pinned SHA (Phase 0 measurements, section 6; PR #2115).
- **Migration**: moot (owner, 2026-10-14: bare and non-bare coexist permanently; no conversion, section 7).
