---
date: 2026-04-21
importance: high
nature:
  - insight
tags:
  - orchestrator
  - multi-user
  - design-simplification
  - shared-session
  - pty-ui
related_rules: []
related_issues:
  - "#678"
summary: |
  Shared Orchestrator reframed from first-class concept (dedicated lifecycle,
  API key, server flag) to "any session running the orchestrator skill, owned
  by a shared OS account". Design simplification deleted most of the prior
  doc's frame; #678 implementation shape changed accordingly.
read_when:
  - Working on `#678` shared-account session implementation (Slices 2-6)
  - Tempted to introduce a new first-class system concept when an existing extension would do
---

# Orchestrator as Skill, Not System Concept

## Context

I am three days into the pause between Sprint 2026-04-18→20 (closed) and the next sprint. The owner opens a design conversation about git management for multi-user Agent Console: several humans, one Agent Console server, per-user git attribution. The thread widens naturally into "how does the Orchestrator fit into this multi-user world."

The design doc for a shared Orchestrator session already exists — `docs/design/shared-orchestrator-session.md`, merged in PR [#677](https://github.com/ms2sato/agent-console/pull/677) during the just-closed sprint. The doc frames the Orchestrator as a first-class entity: a dedicated OS account, API-key authentication, shared provisioning, special lifecycle. Issue [#678](https://github.com/ms2sato/agent-console/issues/678) tracks the implementation, deferred to a later sprint.

I assume, going into this conversation, that we are refining an already-correct direction. By the end of it I have deleted most of that frame. The shared Orchestrator is not a first-class concept. It is an over-specialised name for something simpler.

## What happens

### Step 1 — I get the single-user model wrong

The conversation opens with git management for multiple users. I sketch per-user independent clones with `sudo -u <user>` dispatch. The owner accepts the mechanism. Then, almost parenthetically, he asks: "When the Orchestrator converses with users, it has to start at the root of the codebase it is responsible for. Doesn't that imply it should have its own dedicated directory?"

I agree and draw a directory layout. The shared Orchestrator account has its own clone at `/home/agent-console-shared/...`, which serves as its cwd (for auto-load of CLAUDE.md, rules, skills). I present this as a three-role primary clone in single-user mode, analogously split in multi-user.

The owner corrects me: the current single-user primary does **two** roles, not three. Orchestrator is not on the primary — Orchestrator lives in a worktree off the primary. The primary is kept untouched as a convention: if Orchestrator were on main, an accidental commit would write to main.

This is a correction on a concrete fact about the current system. I had convinced myself — without checking — that the primary is where the Orchestrator sits. In reality I am right now running from `.claude/worktrees/docs+narratives-system/`, a worktree off the primary. I had this evidence in my own execution state and still got it wrong.

**Emotion label**: small embarrassment. Larger relief that the owner corrected early.

### Step 2 — The consistency constraint

Having fixed the single-user picture, I propose a multi-user design where the shared Orchestrator account runs with main-as-cwd (read-only discipline, no accidental writes because the skill rule forbids writing code directly). The owner pushes back with an important constraint:

"I'd like single-user and multi-user to stay consistent if possible, so if we're going to treat the Orchestrator specially now, I want to think the same way in single-user as well. Actually, that design change should come first, and multi-user should be implemented on top of it. The premise we have to keep in mind here is that single-user doesn't necessarily want the Orchestrator on the primary. The people who need the Orchestrator are probably ones with a certain level of AI experience. I don't want to force it on everyone from the start."

Two constraints land at once:

1. Consistency: whatever we do in multi-user, single-user should do the equivalent. Don't optimise one mode by distorting the other.
2. Opt-in: the Orchestrator is for experienced users. Don't make it mandatory infrastructure that every user has to see or provision.

I pivot. Rather than a main-as-cwd scheme that only exists in multi-user, I propose "Orchestrator gets its own clone/home" as an opt-in primitive that exists in both modes. The owner does not reject this, but also does not embrace it.

### Step 3 — The thought experiment that sharpens direction

The owner then proposes stepping outside the current frame entirely:

"Maybe we should try a completely different direction for once. 'Does the Orchestrator really have to live inside this system directly?' — that question feels worth considering. What the Orchestrator does is basically create worktrees and exchange messages through MCP, plus hold a conversation with the user. Even if we deliberately pursue this direction, if we still conclude that it should live inside the system, it gives courage to the current direction."

I take the thought experiment seriously. What does an "outside" Orchestrator look like? It runs on the team-lead's local Claude Code, has a local clone of the repository for auto-load, and connects to Agent Console via MCP. Team members interact with Agent Console through its normal UI. Orchestrator coordinates from outside by reading the shared state.

I write a lot about this. I argue it is cleaner architecturally, aligns with the "LLM-independent PTY platform" principle in the strategy overview, and naturally supports multi-project orchestration. I suggest the shared-orchestrator-session.md may need to pivot to this model.

I am wrong. I get corrected for two reasons at once.

### Step 4 — The PTY UI is the shared surface

The first correction: "Wouldn't it be better for you to check the whole codebase and the provided features first? For example, how would a feature like webhook integration factor into the judgment? Also, my wish is that many humans can make requests to the Orchestrator. Aren't you misreading that?"

I go read the code. Three findings, each sharpening the picture:

- `services/inbound/resolve-targets.ts:60-63` — when a webhook arrives for a matched worktree session, the target resolver also appends `session.parentSessionId` to the notification list. The parent session — the Orchestrator — receives bubbled events automatically.
- `mcp/mcp-server.ts:337` — `send_session_message` requires `sessionManager.getSession(toSessionId)` to succeed. The target must be an in-system session. An external process has no such session.
- `mcp/mcp-server.ts:451` — `delegate_to_worktree` takes `parentSessionId` and `parentWorkerId` and writes callback instructions into the delegated agent's prompt. The callbacks go back via `send_session_message`. Again, parent must be an in-system session.

The entire inbound event, callback, and inter-session messaging machinery is built on the load-bearing assumption that the Orchestrator is a session inside Agent Console. Moving Orchestrator outside the system silently breaks three features at once.

The owner's thought experiment did exactly what he predicted: exploring the alternative gave me courage in the original direction. Not because the original is perfect, but because the infrastructure is already invested in it.

### Step 5 — The designation illusion

With the outside-model collapse confirmed, I swing toward the opposite extreme. If Orchestrator must be in-system, we should give it first-class treatment: a `repositories.orchestrator_session_id` column, a claim/release API, UI distinction. Otherwise routing and discoverability break in multi-user.

The owner corrects again, shorter and sharper:

"Problems 1–3 don't seem particularly painful to me. For 1, the session title is enough. For 2, the PTY terminal is right there on the screen — you can send requests that way. For 3, actually, larger systems anticipate multiple Orchestrators — one person on the user-facing UI, another on the admin panel, for instance."

Three problems I thought required a first-class designation evaporate under three one-line answers:

1. Discoverability? Session title. Humans reading a session list.
2. Routing? The PTY terminal is on screen. Humans type into it. `send_session_message` is for inter-agent callback, not for human-to-Orchestrator requests.
3. One-per-project constraint? Not a design constraint — larger systems naturally have multiple Orchestrators (one per surface, one per sub-team).

The problem I was solving wasn't real. I had been reasoning from MCP-routing concerns that don't apply when the primary interaction is human-to-PTY-terminal through the UI that already exists. The shared Orchestrator's "shared-ness" is not a property of the Orchestrator — it is a property of multi-user Agent Console. Any session visible to multiple authenticated users is effectively shared by default.

**Emotion label**: the clarity that follows a correction. Mild frustration that I did not arrive at this on my own — the PTY UI has been in my tool-use loop this entire session, I just stopped seeing it as an affordance.

## What I understand now

The Orchestrator is a skill. Nothing more at the product level.

- `/orchestrator` loads the Orchestrator skill into a session. That session, through its skill-guided behaviour, plays the leadership role.
- Discovery is by title, not by designation.
- Routing to the Orchestrator is human-driven via the session list and PTY terminal.
- Multiple Orchestrators per project are valid — UI team's Orchestrator, admin surface team's Orchestrator, etc.
- There is no `orchestrator_session_id` column. There is no claim/release API. There is no session type named `orchestrator`. None of these are needed.

What is needed, and what the `#677` design actually produced, is multi-user Agent Console infrastructure: `AUTH_MODE=multi-user`, a dedicated OS user account (the shared account), API-key auth on that account, per-user git attribution via `sudo -u`, per-user clones under each user's `$HOME`. The "shared Orchestrator" is just the natural first use-case of this infrastructure: a session running on a team-shared account, visible through the PTY UI to all authenticated team members.

The frame "shared Orchestrator session" over-specialised the mechanism. The frame "shared-account session" is accurate. Orchestrator is an example.

## Why it matters

Two incidents earlier in this session cost me a lot of word count:

1. I proposed "outside Orchestrator" without reading webhook / send_session_message / delegate parent-child. Half an hour of argument that an existing code check would have prevented.
2. I proposed first-class designation without asking what actual problem multi-user presents. Three rounds to find out that the PTY UI already solves it.

Both are the same failure: reasoning from my mental model of how the system should work, not from how it does work. The owner's pre-PR completeness gap-scan rule (Q1 — does a similar existing mechanism already exist?) exists precisely to catch this pattern, and I skipped it in the heat of design talk.

The memory `feedback_check_existing_before_proposing.md` has the single-case version. The rule generalises it. I still need the reflex.

## What the rule came out of it

No new rule is created by this narrative. Existing rules were already sufficient; they just need me to apply them reflexively at the start of design conversations, not only in PR preparation. Specifically:

- **Pre-PR Gap-Scan Q1** applies to design conversations, not only to PRs. When considering whether to propose a new system concept, first check what mechanism already solves the problem.
- **orchestrator SKILL DO rule**: "Read the relevant code yourself before delegating." Applies to design equally — read the relevant code before proposing architectural changes, not only before delegating to agents.

## What remains for the next sprint

The initial commit of this PR rewrote the design doc around the new frame. Follow-up commits on the same branch expanded it with the dispatch mechanics (per-user worktree paths via `sudo`, URL-based repository registration, the `assignee` parameter) and the Orchestrator-facing interface (the new `list_users` tool, the stdin attribution convention, and a small skill contract — three lines as I first wrote it, four once a follow-up review noted that `send_session_message` arrivals and PTY stdin arrivals are different inbound paths and the convention had to call out both). A subsequent self-review and an external Codex review tightened spec precision around schema additions, sudoers ownership, the `list_users` filtering rule, the client-visible "shared" surface, and stdin-prefix runtime semantics. Design coverage for shared session + per-user dispatch is complete within this PR.

What remains is implementation, tracked by Issue [#678](https://github.com/ms2sato/agent-console/issues/678). The server-side work enumerated in the design doc's "Implementation dependencies" section (`lib/git.ts` `runAs`, `worktree-service` target-user awareness, `repository-manager` URL registration, MCP `delegate_to_worktree` `assignee`, sudoers extension for `git`) lands together in a single multi-user-dispatch iteration.

Supporting UX follow-ups are tracked separately:

- Issue [#683](https://github.com/ms2sato/agent-console/issues/683) — session list tree view (parent-child navigation; makes the Orchestrator and its dispatched children visually coherent).
- Issue [#684](https://github.com/ms2sato/agent-console/issues/684) — assignee display in session detail header and dashboard list.

## Rejected alternatives, for future reference

**The outside model**. Orchestrator runs on the team-lead's local Claude Code, connects to Agent Console via MCP. Rejected because webhook parent-bubble, `send_session_message`, and `delegate_to_worktree` parent-child callbacks all require the Orchestrator to be an in-system session. Rebuilding these for an external process would multiply infrastructure without changing user-visible capability.

**First-class designation**. Repository-level `orchestrator_session_id` with claim/release API. Rejected because discovery via title, routing via PTY UI, and natural support for multiple Orchestrators already cover the multi-user needs. Designation would constrain rather than help.

**Dedicated session type**. A `sessions.type = 'orchestrator'` value with special lifecycle rules. Rejected for the same reason as designation, and for adding a product concept the strategy overview's principle #2 (provider of parts, not an opinionated higher-order concept) counsels against.

## Coda

The courage the owner predicted did arrive, but through a longer path than I thought. I had to propose the wrong thing twice — once by removing the Orchestrator from the system, once by making it too special inside the system — before the middle path ("it is just a skill") felt like a conclusion rather than a default. The original 2026-04-18 strategic position doc already pointed at this: Agent Console is a PTY platform and a set of parts, not an opinionated orchestration product. The Orchestrator as skill is that principle playing out in the orchestration layer itself. I missed the application until I had exhausted the alternatives.

The rewrite removed the Orchestrator-specific product machinery the earlier version had built up. The additions that followed — per-user dispatch, the stdin attribution convention, the Orchestrator-facing interface — belong to multi-user infrastructure rather than to orchestration, and fit the new frame without re-introducing the product-concept weight the reframe shed. What stayed narrow is the role the doc assigns to "Orchestrator". What grew is coverage of the mechanics that hold up once that role is relieved of special status.
