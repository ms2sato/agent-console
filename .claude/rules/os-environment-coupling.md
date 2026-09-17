---
paths:
  - "packages/server/**"
  - "scripts/**"
  - "docker/**"
  - ".github/workflows/**"
---

# OS Environment Coupling

When code depends on OS-level mechanisms — `sudo`, file ownership / mode / setgid, login shell init, PAM, ACL, group membership, systemd unit env, sudoers config — unit tests on the developer's machine cannot establish correctness. Distro / sudoers / shell-init / kernel variations produce real failure modes that look identical to "works on my machine" from the inside.

This rule captures three complementary disciplines. The first two arose from concrete pain in Sprint 2026-06-23 → 2026-06-25 (the multi-user direct-path delivery); the third from Issue #1221 (Sprint 2026-07-22). All three are always-on for the listed triggers; all are cheap when applied up-front and expensive when discovered post-merge.

## Triggers

Apply this rule when a PR introduces or modifies:

- `sudo` / `su` / `runuser` / `setuid` / `setgid` invocations
- `chmod` / `chown` / `setfacl` / `mount` / `umount` calls
- A systemd unit file or sudoers configuration template
- A new install / bootstrap / deploy script under `scripts/`
- A code path that runs as a different OS user than the calling process (e.g., privilege elevation in `MultiUserMode`)
- `pamtester` / PAM module use, or any auth that hits the host OS account store
- SSH agent forwarding, SSH key loading, or `ssh-keygen` calls

If the diff touches none of the above, this rule does not apply.

## Discipline 1: Real-machine smoke tests for OS-coupled code

Unit tests assert the *shape* of an OS-call site (e.g., the argv passed to `sudo` is `['-u', 'alice', '-i', 'sh', '-c', ...]`). They cannot assert what happens when that argv reaches the actual OS — `sudo -i` may strip env vars the unit test did not anticipate, the elevated user's login shell may not include `~/.bun/bin` in PATH, a posix_spawn may EACCES because of inherited cwd, etc.

Add a **smoke test** that runs the production code path on the actual machine and asserts the observable end state:

- Lives under `scripts/smoke/*` (sibling to `scripts/smoke/check-multiuser-pty-env.ts`)
- Imports the production helper directly (no manual replication; drift would defeat the smoke). For example, `check-multiuser-pty-env.ts` imports `buildElevationArgs` from `packages/server/src/services/elevation-args.ts`, so production and smoke cannot diverge on the argv shape.
- Spawns the actual binary (real `sudo` against the real `/etc/sudoers.d/*`, etc.) rather than mocking
- Captures the post-run state (env vars, file ownership, exit code, stderr) and asserts both positive (expected values present) and negative (forbidden values absent)
- Exits `0` on success, `1` on assertion failure (the smoke ran and the system is wrong), `2` on bad usage / probe-launch failure (the smoke could not even run) — distinct exit codes so operators can tell apart the two cases
- Is documented in `docs/multi-user-setup-guide.md` "Post-deploy Verification" section so operators run it post-deploy

The smoke is **load-bearing**: write it before opening the PR, run it before merging, and re-run it after every deploy that touches a privilege-elevation path. The smoke is the only mechanism that can catch distro / sudoers / shell-init quirks before they reach a user.

### Negative assertions are mandatory, not optional — at both layers

The unit test and the smoke test verify different things and BOTH need negative assertions:

- **Unit test (helper / command-shape layer)**: asserts the shape of the shell command string the helper emits — e.g., `expect(innerCommand).toContain("TERM='xterm-256color'")` AND `expect(innerCommand).not.toMatch(/(?:^|[\s;])export\b[^;]*\bPATH=/)`. This verifies the HELPER does not add a forbidden export to its argv. It does NOT verify what the elevated process actually sees, because `innerCommand` is the string handed to the elevation invocation, not the post-elevation environment.
- **Smoke test (real-machine, post-elevation layer)**: asserts the ACTUAL env the elevated process sees after the full chain has run (privilege elevation + login shell init + everything the kernel and the distro contribute). E.g., parse the output of an `env` invocation under elevation, then `expect(envMap.get('TERM')).toBe('xterm-256color')` AND `expect(envMap.get('PATH')?.includes(serviceAccountOnlyPath)).toBe(false)`.

The two layers catch different bugs. The unit test catches "the helper is emitting the wrong shape". The smoke catches "the helper emits the right shape but the OS chain mutates it" (sudoers `env_reset` stripping, login shell init injecting, etc.) AND "the helper is right but a sibling code path bypasses it". Skipping either layer leaves a gap.

**Concrete case (`#866` regression).** PR `#864` made the helper emit `export PATH='<agentconsole's PATH>' ...` into `innerCommand`. The unit test added by PR `#864` asserted only the positive (`TERM='xterm-256color'` present), so the unit test did not catch the leak. PR `#867` added negative assertions at both layers: a unit-test negative on the helper's `innerCommand` shape (`not.toMatch(/PATH=/)`) AND a smoke-test assertion against the actual post-elevation env on the dogfood host. Either alone would have been incomplete: the unit-test negative locks the helper's contract; the smoke confirms the OS chain delivers what the helper intended. The combination is what makes the discipline load-bearing.

### Don't trust "should work" reasoning about OS behavior

When designing OS-coupled code, every assumption about distro behavior ("sudo preserves TERM by default", "agentconsole can exec `/usr/bin/getent`", "Bun's `spawn` honors PATH the same as the OS shell") must be either:

- Verified by running the actual command on the target distro, OR
- Replaced with a more conservative design that doesn't depend on the assumption

Documentation that asserts a behavior is acceptable as a starting point, but does not substitute for verification. Sprint 2026-06-24 hit three sequential machine quirks (PATH lookup with cross-user binaries, `getent` posix_spawn EACCES, `sudo` posix_spawn EACCES via cwd inheritance) where each "should work" assumption was wrong on the dogfood host despite being plausible from documentation.

## Discipline 2: No unilateral modification of OS state outside the project's own scope

When implementing OS-coupled code, the project's writes must stay inside paths the project owns:

- `/var/lib/<project>/...` (project-owned data root)
- `/home/<service-user>/...` (service account's own home)
- `/etc/systemd/system/<project>.service` (the project's own unit, with `--force` gating already established by `setup-multiuser-for-ubuntu.sh`)
- `/etc/sudoers.d/<project>` (the project's own sudoers drop-in)

The project's writes must NEVER, without explicit per-action operator consent, modify:

- `/home/<operator>/...` — the developer's or interactive user's home tree (including ACL grants like `setfacl -m u:agentconsole:rX /home/ms2sato/...`)
- `/etc/passwd` / `/etc/group` / `/etc/shadow` (membership changes via `gpasswd` etc.)
- System-wide sudoers (`/etc/sudoers` proper)
- Other applications' systemd units, SSH host keys, or any host config
- File ownership / mode on paths outside the project's own scope

This applies even to "narrow" changes (a single `x` bit on the operator's `/home`, a single ACL entry granting traverse-only access to a service user). Narrow changes accumulate, leak into other security contexts, and violate the operator's expectation that scripts they invoke do not silently expand other users' filesystem reach.

### Acceptable alternatives when the project needs cross-user access

When the project genuinely needs the service user to access files in the developer's home tree (e.g., for a dev-mode multi-user instance):

- **Rsync to a service-owned target.** Copy the relevant files to `/home/<service-user>/...` so the service user reads from its own home. Mirror production's deploy pattern. Trade-off: source-of-truth diverges from the developer's editor; document the iteration loop (re-rsync on edit).
- **Bind mount to a project-owned path.** `mount --bind <developer-path> /var/lib/<project>-dev-source` so the service user accesses via the project's path. Lower friction than rsync but requires root + ephemeral by default.
- **Explicit consent prompt.** If neither alternative fits, the script must surface the proposed permission change, show the exact command(s) it will run, and require an explicit yes from the operator before each modification.

The choice between these is a design decision worth documenting per script (in the script's header and in the relevant operator guide).

### Concrete case

`scripts/dev-multiuser.sh`'s first draft (PR `#868`) attempted to grant `agentconsole` traverse permission (`u:agentconsole:x`) on every parent directory from `/home/<developer>/.../worktree` up to `/`. The change was conservative-looking (no read, just traverse), correctly motivated (the service user needs to walk the path to reach the worktree), and would have worked. The owner correctly stopped it before it shipped: even a traverse ACL on `/home/<developer>/` is a meaningful expansion of `agentconsole`'s reach into a tree the operator never volunteered to share. The rewrite used rsync to a service-owned target instead.

The owner's intuition matched the rule above: the project's writes stay in the project's scope. The script's iteration ergonomics suffered slightly (re-rsync on server-side edits), and that is the correct trade-off.

## Discipline 3: Elevated commands must not resolve binaries by PATH-only name

A command string handed to `sudo -u <user> -i sh -c '<command>'` (or any equivalent elevation invocation) must not reference a binary by bare command name (`bun`, `node`, a user-local tool) when that binary lives outside the standard system paths (`/usr/bin`, `/bin`, `/usr/local/bin`). Elevated, non-interactive login shells do not behave like an interactive login: on Ubuntu, `sudo -u <user> -i sh -c '...'` invokes `dash` as the inner shell, which does not source `.bashrc` (bash-only, interactive-only). A user-local install under `~/.bun/bin` (or any PATH entry that only exists via `.bashrc`/`.profile` sourcing) is therefore NOT resolvable by bare name inside that shell, even though the same command works fine when the developer types it in their own terminal.

The failure mode is a plain "command not found" (exit 127) with no indication that the root cause is shell-init semantics rather than a missing install — easy to misdiagnose as an installation problem on the target machine.

**Fix pattern:**

1. Resolve the binary's absolute path via a config value (env var with a sensible default for single-user/dev, e.g. `EMBEDDED_AGENT_BUN_PATH` defaulting to `process.execPath` — the running server's own binary, exact by construction rather than PATH-resolved, Issue #1291), not a hardcoded bare name.
2. Have the setup / bootstrap script for elevated (multi-user) deployments copy (not symlink — see Discipline 2's home-directory-permission concern; a service user's HOME is typically mode `0700`, so a symlink target under it is unreachable by other elevation-target users) the binary to a location every elevation-target user can traverse (e.g. `/usr/local/bin/<binary>`), and set the config value to that absolute path in the deployment's systemd unit / environment.
3. Copy from the SAME binary the elevating/server process itself runs (not an arbitrary system install), to avoid version drift between the server and the elevated subprocess.

**Canonical example:** the embedded-agent worker's `bun <entry>` invocation (`packages/server/src/services/embedded-agent-worker-service.ts`), fixed via `EMBEDDED_AGENT_BUN_PATH` (`packages/server/src/lib/server-config.ts`) plus a bun-binary copy step in `scripts/setup-multiuser-for-ubuntu.sh` (Issue #1221). Before the fix, every embedded-agent worker activation failed under multi-user mode with a cross-user PATH-resolution error, caught by the owner's cross-user smoke run rather than by unit tests (unit tests assert argv shape, not what the OS actually resolves — the same "unit test cannot establish correctness" gap Discipline 1 exists for).

## Discipline 4: Verification tiers for elevation-coupled code

Code that runs, renders, installs, or reads the multi-user systemd unit, the elevation rules, or the deploy scripts is verified at one of four tiers. Put each check at the LOWEST tier that can observe it; a check placed higher than it needs to be is an owner-run ritual waiting to happen.

| Tier | Where | What belongs there |
|---|---|---|
| 1 | unit / memfs, every PR's CI | pure logic with injectable io (`assessEmbeddedAgentBunPath`, `ensureMemoryDir`, the `scripts/lib/setup-multiuser-checks.sh` helpers via fixtures) |
| 2 | the verification container, no systemd (`scripts/verify-multiuser-docker.sh --smokes`) | the seven real-host smokes, PTY / elevation isolation, uploads, worktrees, shared sessions |
| 3 | the systemd stack, systemd as PID 1 in a privileged container (`scripts/verify-multiuser-systemd.sh`), **ephemeral runner or personal workstation ONLY** | the setup script, the deploy script, unit render + drift detection, elevation-rules install, `MainPID` identity, wrong-gid / right-gid classification |
| 4 | the production host, owner-run, once per deploy | the deploy command with its built-in post-deploy verification; billable smokes |

**Tier 3 never runs on the dogfood host.** Booting systemd as PID 1 needs `--cap-add SYS_ADMIN --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock -e container=docker --security-opt apparmor=unconfined` (the least-privilege set measured in `docs/design/elevation-verification-tiers.md`'s Task 0 — `CAP_SYS_ADMIN` plus a writable host cgroup tree in the host cgroup namespace, plus an AppArmor opt-out; `--privileged` was never reached); either grant is root-equivalent on the host that lends it, and the dogfood host carries the production unit and every real account. The mechanical gate lives in the driver itself (`scripts/verify-multiuser-systemd.sh`): it runs only when `AC_TIER3_RUNNER=github-hosted` (set by the workflow from GitHub's own `runner.environment` context) or `AC_TIER3_HOST_OK=1` (the explicit workstation opt-in) is set. `CI=true` is deliberately NOT accepted — any self-hosted runner sets it, including one that could be registered on the dogfood host. A delegate on the dogfood host drives tier 3 by pushing a branch that the paths-filtered workflow (`.github/workflows/verify-multiuser-systemd.yml`) picks up, never by `docker run` / `docker compose up` on the host. Tier 2 may run on the dogfood host (it needs the `docker` group only, no privilege flag).

**What tier 4 keeps is a property of THE host, not of the code**: the deploy of the unit, its health, its `MainPID` identity, the readability of that host's `/usr/local/lib`, and the billable smokes. The one command is `scripts/update-and-deploy-for-multiuser-ubuntu.sh`, which ends with a seven-line post-deploy verification screen (V0 data-root-ownership, V1 unit-env-drift, V2 entry-path-readable, V3 mainpid-identity, V4 unit-active, V5 health, V6 journal-digest) and exits with the worst code observed (0 = all PASS, 1 = a FAIL, 2 = a SKIP with no FAIL); spec and cell-by-cell detail live in `docs/design/elevation-verification-tiers.md`'s "Post-deploy verification -- checks enumerated" table. Billable smokes (a real `claude` CLI login or a provider key for the invoking OS user) stay tier 4 as permanent residue — no container in this design carries either credential, by decision. When a new owner-run check appears, ask which of those tier-4 properties it is; if it is none of them, it belongs at tier 3 or lower and its appearance at tier 4 is a gap to file.

**The elevation literal is handled by the exec shape, not by an allowlist and not by obfuscation — and by which TOOL writes it, measured 2026-09-17.** A tier-3 driver reaches root, the service user, and the operator through `docker compose exec --user <root|deployer|agentconsole|agentconsole:agent-console-users>`: the exec shape itself carries no elevation literal, and everything that elevates runs INSIDE the container from the repository's own scripts. Separately, the delegate-sandbox guard that blocks the literal in a tool call scans Bash tool input only — command lines and heredoc / file content written through Bash — and does not scan the Write or Edit tools, which accept the literal in file content normally. So: files that must carry the literal (`docker/deployer-elevation-rules`, the Dockerfile `COPY` line that installs it, the workflow's `AC_TIER3_ELEVATE` value) are written with the Write or Edit tools, never composed through Bash; a delegate who needs a new such file and finds Write/Edit sufficient writes it directly, and stops and reports only if the file cannot be produced that way. (The earlier premise — that any file carrying the literal was categorically "the owner's line to write" — is retracted: `docker/deployer-elevation-rules`, its Dockerfile `COPY` line, and the workflow's `AC_TIER3_ELEVATE` value were all delegate-written, in PR #1711.) Keep the rule's SHAPE (no allowlist, no obfuscation); what changed is who can write the file and how, not whether the literal is confined to the files that already need it.

**A third label covers what does not fit tiers 2-4.** Unprivileged smokes (real process, no elevation, no billing) need none of tiers 2-4; they run wherever bun runs and are listed in `test-trigger.md` with that label.

Cross-references: `docs/design/elevation-verification-tiers.md` is the single writer of the tier DEFINITIONS and the study that measured the tier-3 premise (Task 0); this rule carries the table and the operational discipline. `test-trigger.md`'s per-smoke sections each name their tier. `docker/README.md`'s residue paragraph names the tiers instead of listing residue.

## How to use this rule

When writing code that hits the triggers above:

1. **Design phase** — before writing the code, decide:
   - What OS state will the code observe (read) or modify (write)?
   - For writes: is the path within the project's own scope? If not, redesign per Discipline 2.
   - For reads: which assumptions about OS behavior is the code depending on? Plan a smoke test for each.

2. **Implementation phase** — write the production code and the smoke test together. The smoke test must import the production helper, not replicate it. Negative assertions are mandatory.

3. **Pre-merge phase** — run the smoke test on the actual deploy target before the PR is mergeable. If the smoke fails, the failure is data, not noise: fix the design and re-smoke. Sprint 2026-06-24 caught three machine quirks via this loop, each of which would have shipped to internal release as a production incident without the smoke.

4. **Post-deploy phase** — re-run the smoke after every deploy that touches the relevant code path. Document the invocation in `docs/multi-user-setup-guide.md` so operators have an authoritative checklist.

5. **Registering a smoke (Discipline 4)** — when registering a smoke in `test-trigger.md`, give its section the tier clause (vocabulary above): `Tier 4 (billable; dogfood host only -- permanent residue)`, `Tier 2 (the verification container's --smokes run)` (plus `and Tier 3 (systemd stack, against the real MainPID)` when the smoke also runs there), or `Unprivileged (no tier-2/3/4 residue; any machine with bun)`.

## Cross-references

- [`pre-pr-completeness.md`](./pre-pr-completeness.md) — Question 6 ("Layer-Boundary Crossing Checklist for cross-runtime spawn") is the adjacent rule for cross-runtime invocations. This rule extends the same discipline to OS-coupled code more broadly (PATH / ownership / sudoers / shell init quirks beyond cross-runtime spawn).
- [`workflow.md`](./workflow.md) — the Verification Checklist and Definition of Done are unchanged by this rule; the smoke test is an ADDITIONAL gate for OS-coupled code, layered on top of unit tests.
- [`design-principles.md`](./design-principles.md) — "Enforce constraints through structure, not convention" applies here too: when the project's scope and the operator's scope are conflated, structure (rsync target vs ACL grant) is more reliable than convention (a note to the operator that the script "is safe").
- Reference smoke implementation: `scripts/smoke/check-multiuser-pty-env.ts` + `packages/server/src/services/elevation-args.ts`.
- Documented operator section: `docs/multi-user-setup-guide.md` "Post-deploy Verification".
- [`docs/design/elevation-verification-tiers.md`](../../docs/design/elevation-verification-tiers.md) — Discipline 4's tier table is landed here; that study document stays the single writer of the tier DEFINITIONS and the measurements behind them (Task 0). This rule carries the table and the operational discipline, not the measurements.
