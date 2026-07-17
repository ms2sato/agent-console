# Worked Example: Embedded Agent UI Browser QA

Concrete, replayable steps for Browser QA of the Embedded Agent chat surface
(`EmbeddedAgentWorkerView.tsx` and related components) without a real LLM
provider. Distilled from three delegates (PR #1073, PR #1092-series, PR
#1125) independently reinventing the same 5-6 step setup during Sprint
2026-07-16 — see [Issue #1126](https://github.com/ms2sato/agent-console/issues/1126).

Use this when the PR touches embedded-agent chat rendering (message bubbles,
thinking/reasoning accordion, tool-call cards, markdown rendering, long-token
wrapping) and the base [Browser QA procedure](SKILL.md) needs an
embedded-agent-specific setup.

## 1. Start an isolated dev instance

Run the dev server against a throwaway data directory and non-conflicting
ports so it does not collide with any already-running instance (including
the one your own delegate session might be running under):

```bash
export QA_HOME=$(mktemp -d)
export AGENT_CONSOLE_HOME="$QA_HOME"
export CLIENT_PORT=5183   # pick a port not already in use
export PORT=3467          # pick a port not already in use
```

Check `.env` and any already-running `bun run dev` processes first (`ps aux
| grep concurrently`) to pick ports that do not collide.

## 2. Unset your own session's `AGENT_CONSOLE_*` env vars

If you are running this from inside a delegate session (a PTY itself
launched as an embedded-agent worker), your shell already has
`AGENT_CONSOLE_*` vars pointing at *your own* session. `bun run dev` inherits
the shell env, and the dev server's embedded-agent subprocess spawn inherits
it too — the newly-activated worker in your throwaway session then
misroutes to your own session's MCP server instead of the new one.

Unset explicitly before starting the dev server:

```bash
env -u AGENT_CONSOLE_BASE_URL \
    -u AGENT_CONSOLE_SESSION_ID \
    -u AGENT_CONSOLE_WORKER_ID \
    -u AGENT_CONSOLE_REPOSITORY_ID \
    -u AGENT_CONSOLE_PARENT_SESSION_ID \
    -u AGENT_CONSOLE_PARENT_WORKER_ID \
    -u AGENT_CONSOLE_MCP_TOKEN_FILE \
    bun run dev
```

## 3. Use `bun run dev`, not `bash scripts/dev.sh`

`scripts/dev.sh` ends with `exec concurrently ...`. `concurrently` is a
workspace devDependency resolved via `node_modules/.bin`, which is only on
`PATH` when the script is invoked through `bun run dev` (Bun prepends
workspace `.bin` to `PATH` for `bun run`). Invoking the script directly with
`bash scripts/dev.sh` skips that `PATH` setup and fails with `concurrently:
command not found`.

Combine steps 1-3 into one command, backgrounded so you can keep issuing
Chrome DevTools MCP calls in the same session:

```bash
env -u AGENT_CONSOLE_BASE_URL \
    -u AGENT_CONSOLE_SESSION_ID \
    -u AGENT_CONSOLE_WORKER_ID \
    -u AGENT_CONSOLE_REPOSITORY_ID \
    -u AGENT_CONSOLE_PARENT_SESSION_ID \
    -u AGENT_CONSOLE_PARENT_WORKER_ID \
    -u AGENT_CONSOLE_MCP_TOKEN_FILE \
    AGENT_CONSOLE_HOME="$QA_HOME" CLIENT_PORT=5183 PORT=3467 \
    bun run dev
```

Run this via the Bash tool with `run_in_background: true` (or `nohup ... &`
if invoking a raw shell) and confirm the startup log shows the frontend on
`http://localhost:5183` before navigating.

If you skip step 2, the newly-activated worker in the throwaway session can
silently misroute to your own delegate session's MCP server instead of the
throwaway one — see the env-leak explanation above.

## 4. Set up through the UI

No real LLM provider is required — the embedded agent never needs to
actually connect for most rendering-focused QA (see step 5 for the
true-path content problem this creates, and its workaround).

1. **Navigate** to `http://localhost:5183` and open **"Add Repository"**.
   Switch to the **"Use existing path"** tab (not "Clone from URL") and
   enter the absolute path of the worktree you are testing (e.g. your own
   checked-out worktree — no need to clone a fresh copy). Submit **"Add"**.
   (`packages/client/src/components/repositories/RegisterExistingPathForm.tsx`)
2. **Create a worktree** from that repository: open the "Create Worktree"
   form, pick a branch mode from the "Branch name:" radio group (**Custom
   name (new branch)** is usually simplest — fill "New branch name"), then
   submit **"Create & Start Session"**.
   (`packages/client/src/components/worktrees/CreateWorktreeForm.tsx`)
3. **Register a throwaway Embedded Agent**: go to `/agents`, click **"+ Add
   Embedded Agent"**, fill the required **"Base URL"** and **"Model"**
   fields with dummy values (e.g. `http://localhost:1/v1` and
   `qa-dummy-model`) — no real provider connection happens unless the agent
   actually sends a message. Submit **"Add Embedded Agent"**.
   (`packages/client/src/components/embedded-agents/AddEmbeddedAgentForm.tsx`)
4. **Add the agent as a worker** to the session created in step 2: click the
   **"+" ("Add agent worker")** button and pick your embedded agent from the
   dropdown (badge "Embedded · Experimental").
   (`packages/client/src/components/sessions/AddAgentWorkerMenu.tsx`)

## 5. Reach true-path content with a temporary query-gated stub

A dummy Base URL means the agent never produces real chat/thinking/tool
content — the worker view stays empty. To screenshot the actual true-path
rendering (message bubbles, thinking accordion expanded, tool-call cards),
add a temporary, **uncommitted** stub gated behind a query parameter so it
never affects production behavior:

```tsx
const isStub =
  typeof window !== 'undefined' &&
  window.location.search.includes('stub-thinking');

const displayItems = useMemo(
  () => (isStub ? STUB_DISPLAY_ITEMS : realDisplayItems),
  [isStub, realDisplayItems],
);
```

Navigate with `?stub-thinking` appended to the URL, take the true-path
screenshots (per `workflow.md` "Gated / conditional UI true-path
requirement" — false-path-only screenshots are not sufficient for
conditionally-rendered UI), then **fully revert the stub**:

```bash
git checkout -- <the component file you stubbed>
```

Confirm with `git status --porcelain` that no stub code remains before
opening the PR — this pattern was used and reverted this way in PR #1073,
PR #1092-series, and PR #1125.

## 6. Single-file before/after comparison (optional, for regression-fix PRs)

When the PR's screenshot needs a genuine "before this fix" vs "after this
fix" comparison of the same component, do **not** use `git stash` —
`refs/stash` is shared across all linked worktrees of this repo (all
worktrees of the same clone share one `.git` common dir, so `refs/stash`
is a single stack), and concurrent delegate sessions in sibling worktrees
can pop each other's WIP. Use `git show` instead, scoped to the single
file:

```bash
# Swap in the pre-fix version, let HMR pick it up, screenshot "before"
git show HEAD~1:packages/client/src/components/embedded-agents/EmbeddedAgentWorkerView.tsx \
  > /tmp/before.tsx
cp /tmp/before.tsx packages/client/src/components/embedded-agents/EmbeddedAgentWorkerView.tsx

# Restore the fix, let HMR pick it up, screenshot "after"
git checkout -- packages/client/src/components/embedded-agents/EmbeddedAgentWorkerView.tsx
```

This never touches `refs/stash`, so it is safe to run alongside other
delegates' concurrent sessions in sibling worktrees.

## 7. Cleanup (mandatory, not optional)

Verification artifacts must be removed by default, immediately after
verification — leaving them for "someone to clean up later" is not
acceptable:

1. Confirm the stub from step 5 is reverted: `git status --porcelain` shows
   no uncommitted changes to production files.
2. Remove the throwaway worktree created in step 4.2 (`git worktree list`
   to find it, then the repository UI's remove action or
   `mcp__agent-console__remove_worktree`).
3. Remove the throwaway Embedded Agent definition registered in step 4.3.
4. Stop the isolated dev server (kill the backgrounded process) and delete
   the throwaway `AGENT_CONSOLE_HOME`: `rm -rf "$QA_HOME"`.
5. If any artifact genuinely needs to survive for a follow-up, PAUSE it
   explicitly and note an expiration in the PR body instead of leaving it
   running — do not leave-and-forget.

## Related

- `docs/design/embedded-agent-worker.md` — Embedded Agent architecture and
  wire protocol.
- `CLAUDE.md` "Environment Configuration" — default `PORT` / `CLIENT_PORT` /
  `AGENT_CONSOLE_HOME` values this worked example overrides.
- `.claude/rules/workflow.md` "Gated / conditional UI true-path requirement"
  — why step 5's true-path screenshots are required, not optional.
- PR #1073, PR #1092-series, PR #1125 — prior art this worked example was
  distilled from.
