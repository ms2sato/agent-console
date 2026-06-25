# OS Environment Coupling

When code depends on OS-level mechanisms — `sudo`, file ownership / mode / setgid, login shell init, PAM, ACL, group membership, systemd unit env, sudoers config — unit tests on the developer's machine cannot establish correctness. Distro / sudoers / shell-init / kernel variations produce real failure modes that look identical to "works on my machine" from the inside.

This rule captures two complementary disciplines that arose from concrete pain in Sprint 2026-06-23 → 2026-06-25 (the multi-user direct-path delivery). Both are always-on for the listed triggers; both are cheap when applied up-front and expensive when discovered post-merge.

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

## How to use this rule

When writing code that hits the triggers above:

1. **Design phase** — before writing the code, decide:
   - What OS state will the code observe (read) or modify (write)?
   - For writes: is the path within the project's own scope? If not, redesign per Discipline 2.
   - For reads: which assumptions about OS behavior is the code depending on? Plan a smoke test for each.

2. **Implementation phase** — write the production code and the smoke test together. The smoke test must import the production helper, not replicate it. Negative assertions are mandatory.

3. **Pre-merge phase** — run the smoke test on the actual deploy target before the PR is mergeable. If the smoke fails, the failure is data, not noise: fix the design and re-smoke. Sprint 2026-06-24 caught three machine quirks via this loop, each of which would have shipped to internal release as a production incident without the smoke.

4. **Post-deploy phase** — re-run the smoke after every deploy that touches the relevant code path. Document the invocation in `docs/multi-user-setup-guide.md` so operators have an authoritative checklist.

## Cross-references

- [`pre-pr-completeness.md`](./pre-pr-completeness.md) — Question 6 ("Layer-Boundary Crossing Checklist for cross-runtime spawn") is the adjacent rule for cross-runtime invocations. This rule extends the same discipline to OS-coupled code more broadly (PATH / ownership / sudoers / shell init quirks beyond cross-runtime spawn).
- [`workflow.md`](./workflow.md) — the Verification Checklist and Definition of Done are unchanged by this rule; the smoke test is an ADDITIONAL gate for OS-coupled code, layered on top of unit tests.
- [`design-principles.md`](./design-principles.md) — "Enforce constraints through structure, not convention" applies here too: when the project's scope and the operator's scope are conflated, structure (rsync target vs ACL grant) is more reliable than convention (a note to the operator that the script "is safe").
- Reference smoke implementation: `scripts/smoke/check-multiuser-pty-env.ts` + `packages/server/src/services/elevation-args.ts`.
- Documented operator section: `docs/multi-user-setup-guide.md` "Post-deploy Verification".
