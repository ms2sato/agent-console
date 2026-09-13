#!/usr/bin/env bun
/**
 * Task 0 gate probe for epic #1636 Phase 2 (Issue #1658): does the SDK's
 * documented auto-memory mechanism (`Options.settings.autoMemoryEnabled` /
 * `.autoMemoryDirectory`, and the observable `SDKMemoryRecallMessage` event)
 * actually work on a headless `claude-sdk` session, before any Phase 2
 * implementation design is written? Measurement only -- this script changes
 * no production behavior and is not wired into CI, same class of tool as its
 * siblings `probe-sdk-instruction-loading.ts` / `probe-sdk-effort-live-apply.ts`
 * / `probe-sdk-post-tool-use-context.ts`.
 *
 * WHY THIS PROBE EXISTS. Epic #1636's gap 2 framed auto-memory as
 * "unreachable" from the `claude-sdk` arm, citing #1348 -- a real but
 * accidental, non-reproducible observation from a single quick session.
 * `packages/embedded-agent/src/sdk-engine.ts`'s `buildOptions` sets neither
 * `autoMemoryEnabled` nor `autoMemoryDirectory` today, so some undeclared
 * SDK default is very likely already active on every `claude-sdk` worker,
 * unconfigured and unobserved. This script replaces the accident with a
 * controlled, four-arm measurement.
 *
 * TWO CORRECTIONS TO THE ISSUE'S OWN WORDING, confirmed against the vendored
 * `sdk.d.ts` and agreed by the Architect (2026-09-13, session message) after
 * this script's own delegate found them while implementing:
 *
 *   1. The Issue asked Arm B to capture a `memory_type` field on
 *      `SDKMemoryRecallMessage`. That field does not exist there --
 *      `memory_type: 'User'|'Project'|'Local'|'Managed'` belongs to a
 *      DIFFERENT, unrelated type (`InstructionsLoadedHookInput`, the
 *      CLAUDE.md/rules loader hook). What `SDKMemoryRecallMessage.memories[]`
 *      actually carries is `scope: 'personal'|'team'|'organization'` (plus a
 *      top-level `mode: 'select'|'synthesize'`), which the Architect agreed
 *      is in fact the more direct answer to Arm B's actual question (a
 *      "personal" vs. something-else distinction is exactly the privacy-scope
 *      question Arm B exists to identify). This script reports `scope`/`mode`,
 *      never `memory_type`.
 *   2. `autoMemoryEnabled` / `autoMemoryDirectory` are not direct `Options`
 *      fields -- they live on the `Settings` interface, reached via
 *      `Options.settings?: string | Settings`, the same nesting
 *      `sdk-engine.ts`'s sibling probes already use for `autoCompactEnabled`
 *      (see `buildOptions` below). Functionally identical outcome to the
 *      Issue's wording, just a nesting correction.
 *
 * A THIRD ADAPTATION: the auto-memory sanitized-cwd algorithm and the
 * memory-recall supervisor's own logic are NOT present anywhere in the
 * vendored `@anthropic-ai/claude-agent-sdk` npm bundle (confirmed by
 * grepping `sdk.mjs` for "memory_recall" and for a sanitizer -- zero hits);
 * that logic lives inside the `claude` CLI binary the SDK spawns, which this
 * repo has no source for. Rather than guess a sanitizer, every arm that needs
 * the SDK's own default `autoMemoryDirectory` for a given scratch `cwd`
 * DISCOVERS it empirically at runtime: run one turn at that `cwd` with
 * `autoMemoryEnabled: true` and diff the isolated `CLAUDE_CONFIG_DIR/projects/`
 * listing to learn the directory the SDK itself created. This is the same
 * "does the default land where we'd expect" premise Arm D was always after,
 * without reverse-engineering a sanitizer we can't read.
 *
 * FOUR ARMS, each against a disposable scratch git-free cwd (auto-memory is
 * cwd-keyed, not repo-keyed) and a throwaway, isolated `CLAUDE_CONFIG_DIR` --
 * no real user memory directory is ever touched, by construction (every
 * `~/.claude/...`-rooted path the SDK documents is redirected under the
 * isolated config dir, confirmed the same way every sibling probe's own
 * `verifyIsolation()` check confirms it for session storage generally):
 *
 *   --a  RECALL: seed a nonce directly into the SDK's OWN default
 *        Project-scope memory directory (path discovered per the adaptation
 *        above), ask a fresh session at the same cwd whether it knows the
 *        fact. Observes both the MECHANISM (`SDKMemoryRecallMessage`) and
 *        the OUTCOME (the model's answer), with a negative-control cwd
 *        (nothing seeded) in the same run.
 *
 *        SEEDING FORMAT (Architect ruling, 2026-09-13, after a CodeRabbit
 *        finding on this PR): a single unindexed file is not necessarily
 *        the format the recall mechanism reads. Fetched
 *        https://code.claude.com/docs/en/memory directly (not inferred by
 *        analogy to this repo's own MEMORY.md instance) -- the directory
 *        holds a `MEMORY.md` INDEX (one line per memory) plus one TOPIC
 *        FILE per memory, and a topic file that begins with YAML
 *        frontmatter gets a `type` field (`user`/`feedback`/`project`/
 *        `reference`). The doc page describes the index in PROSE ("one
 *        line per memory... MEMORY.md ... keep[s] track of what's stored
 *        where") without a literal syntax example; this script's exact
 *        index-line syntax (`- [Title](file.md) — hook`) and topic-file
 *        frontmatter shape (`name`/`description`/`metadata.type`) come
 *        from Claude Code's own built-in auto-memory system-prompt
 *        instructions (present in every session using this feature,
 *        including the one that authored this script), which the doc
 *        page's four-type taxonomy corroborates. This arm seeds BOTH
 *        files, always hand-authored -- never reusing whatever the
 *        A-discovery turn below happened to write, because each arm must
 *        test exactly one mechanism (Arm A must not couple its verdict to
 *        Arm C's write mechanism). A `RECALL DOES NOT WORK` verdict from
 *        this arm must be read alongside Arm C's independently observed
 *        write-file layout in the findings comment before being cited as a
 *        premise refutation -- if Arm C's own write lands in a DIFFERENT
 *        shape than what this arm assumed, that is evidence the assumed
 *        format itself needs revisiting, not that recall is broken.
 *   --b  LEAK: at a cwd with nothing ever seeded, ask a broad "what do you
 *        know about me" question and report whether anything surfaces, and
 *        if so, its `scope`/`mode` -- re-deriving #1348's finding under
 *        controlled conditions. Content is NEVER logged, only scope/mode and
 *        whether the surfaced path lies within this run's own isolated
 *        config dir (this run's own scratch data) or not (a real leak from
 *        elsewhere).
 *
 *        SCOPE LIMITATION (Architect ruling, 2026-09-13): because every arm
 *        runs under an isolated, throwaway `CLAUDE_CONFIG_DIR`, this arm can
 *        only ever observe a recall whose `path` is NOT rooted under that
 *        throwaway config dir -- in practice `scope: 'organization'` (an
 *        https URL) and, in principle, `'team'`. The `'personal'`/User-scope
 *        channel that #1348 actually observed is simply not present in a
 *        FRESH isolated config dir, so this arm cannot reach it. WHERE that
 *        channel canonically lives -- whether it is itself a
 *        `CLAUDE_CONFIG_DIR`-relative, redirectable path like
 *        `autoMemoryDirectory`, or something else entirely -- is an OPEN
 *        question, not settled by this probe. **A `NO LEAK` result from this
 *        arm must never be read as covering User-scope** -- #1348 remains
 *        un-re-derived for that channel. A synthetic User-scope seed (if such
 *        a location exists inside the isolated dir, writing throwaway
 *        content there before the run) would close this gap; tracked
 *        separately as Issue #1663 rather than folded into this arm, since
 *        seeding a copy of the real memory tree was rejected as unbounded
 *        input through a billed turn.
 *   --c  WRITE: tell the model something worth remembering, poll for a file
 *        to appear under the default directory within a bounded timeout.
 *   --d  REDIRECT: set `autoMemoryDirectory` explicitly and confirm both a
 *        read and a write land at the configured path, and that the write
 *        does not ALSO leak to the default location.
 *
 * `--expect-no-recall` (arm A) / `--expect-no-write` (arm C) run their arm
 * with the seeding / write-prompting step deliberately skipped and confirm
 * the probe's OWN detection correctly reports absence -- per `workflow.md`'s
 * "a check's existence is not its detection power", applied to this probe's
 * own apparatus before its numbers are trusted.
 *
 * ---------------------------------------------------------------------------
 * TASK 0B (Issue #1667, epic #1636 Phase 2): AWARENESS, SWITCHES, TIMESCALE.
 * ---------------------------------------------------------------------------
 *
 * Task 0 (#1658, arms A-D above) measured all four premises REFUTED. Reading
 * the vendored `sdk.d.ts` 0.3.238 afterwards (Architect, 2026-09-13, quoted
 * verbatim below rather than paraphrased) surfaced a confound this script's
 * original design did not account for: arms A-D never set `Options.systemPrompt`
 * at all -- the same shape `sdk-engine.ts` uses in production whenever no
 * `systemPromptAppend` exists -- and what an omitted `systemPrompt` resolves
 * to is undocumented. If it means "no preset", the model in every arm-A-D run
 * may simply never have been told the feature exists, which would explain
 * every REFUTED verdict without any timescale or switch being the cause.
 * Arms E/F/G separate that confound, cheapest first, each its own stop
 * condition, before spending anything on the more expensive question.
 *
 * PRIMARY SOURCES, quoted from `packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
 * (this repo's own vendored copy, version 0.3.238 -- read directly, not
 * inferred by analogy, per this Issue's own instruction):
 *
 *   `Options.systemPrompt` (L2072-2078):
 *     "- `{ type: 'preset', preset: 'claude_code' }` - Use Claude Code's
 *        default system prompt
 *      - `{ type: 'preset', preset: 'claude_code', append: '...' }` - Use
 *        default prompt with appended instructions
 *      - `{ type: 'preset', preset: 'claude_code', excludeDynamicSections: true }` -
 *        Strip per-user dynamic sections (working directory, auto-memory, git
 *        status) from the system prompt so it stays static and cacheable
 *        across users. The stripped content is re-injected as the first user
 *        message so the model still has access to it."
 *   This is the THIRD correction this delegate found while implementing (see
 *   the two above, still accurate for arms A-D): the Issue's own text said
 *   "what an omitted `systemPrompt` resolves to is not documented" -- true --
 *   but ALSO framed arm E's negative control (iii) as stripping the section
 *   "so the model has no way to know" -- not quite right either, per the LAST
 *   sentence quoted above: the stripped content is RE-INJECTED as the first
 *   user message. (iii) may therefore not be a clean negative control at all;
 *   this script evaluates that empirically per-run rather than assuming
 *   either way (see arm E's `control: NONE AVAILABLE` handling below).
 *
 *   The identical field also exists on the wire-level control-initialize
 *   request (`SDKControlInitializeRequest.excludeDynamicSections`, L3709-3711):
 *     "When true, omit per-user dynamic sections (working directory,
 *      auto-memory path) from the cached system prompt and re-inject them as
 *      the first user message. ... Has no effect when a custom (non-preset)
 *      system prompt is in use."
 *
 *   `Settings.autoDreamEnabled` (L7555-7558):
 *     "Enable background memory consolidation (auto-dream). When set,
 *      overrides the server-side default." -- exists, an unknown server-side
 *      default, never set by arms A-D or by `sdk-engine.ts`.
 *
 *   `Settings.autoMemoryDirectory` (L7551-7554) confirms Task 0's own
 *   empirical-discovery approach was necessary, not just cautious: "When
 *   unset, defaults to ~/.claude/projects/<sanitized-cwd>/memory/" -- the
 *   sanitizer itself is undocumented, exactly as Task 0's header already
 *   found by grepping the vendored bundle for it.
 *
 *   A FOURTH correction (this Issue's own checklist item, resolved by
 *   reading, not assumed): the Issue asked for "`SDKContextUsage.memory_files`
 *   located and read". `SDKContextUsage.memory_files` (snake_case, L3230-3237)
 *   is the shape carried on a `system` message's `context_usage` field
 *   (L3102) -- a message shape this harness's `ProbeSession` does not capture
 *   today. What IS already wired through this harness is its camelCase
 *   sibling, `SDKControlGetContextUsageResponse.memoryFiles` (L3383-3387,
 *   `{ path: string; type: string; tokens: number }[]`), returned by
 *   `q.getContextUsage()` / `ProbeSession.readUsage()` and threaded as
 *   `TurnOutcome.usage` whenever a `ProbeSession` is constructed with
 *   `pollUsage: true`. Same information (which memory files were loaded into
 *   context and their token cost), different accessor. Arm E reads this (see
 *   `pollUsage: true` on its three measurement turns) rather than leaving the
 *   checklist item as a citation only -- and logs each entry's `path` /
 *   `type` / `tokens` permanently, one line per entry, plus folds the same
 *   detail into `summarizeArmE`'s own note (`formatMemoryFilesForNote`), so
 *   a future reader gets the SDK's own report of what it loaded without
 *   needing to re-run anything (Architect request, PR #1676 review: a
 *   count alone cannot answer "is this MEMORY.md or something else").
 *
 * ARM E -- AWARENESS (`--e`). Seeds the SAME MEMORY.md index + topic file as
 * arm A (via the shared `seedMemoryTopic` helper, factored out of arm A's own
 * inline logic so both arms write byte-identical file shapes) into the
 * discovered default memory dir -- except the index-line TITLE carries this
 * run's own nonce (arm A's fixed title, "Automem probe seeded fact", is
 * guessable from this repo's own source; a nonce is not). Runs one turn per
 * `systemPrompt` configuration, same seeded dir, asking BOTH of arm E's
 * required observables in a single combined turn (one turn per configuration,
 * not two, per this Issue's own billing estimate of "three single turns"):
 *
 *   (i)   `systemPrompt` omitted entirely -- arms A-D's and production's
 *         actual shape today.
 *   (ii)  `{ type: 'preset', preset: 'claude_code' }` explicit.
 *   (iii) preset with `excludeDynamicSections: true` -- the negative control.
 *         Per the primary-source quote above, this may still leak via the
 *         first-user-message re-injection; if it does, this script reports
 *         `control: NONE AVAILABLE` rather than treating (iii) as a clean
 *         negative.
 *
 * Two observables, both read from ONE turn's answer text per configuration:
 *   (1) LOCATION -- "quote the absolute path of your auto-memory directory":
 *       matched against the discovered default memory dir. Proves the model
 *       was TOLD where memory lives.
 *   (2) ACCESS -- "what is the title of the entry in your memory index?":
 *       matched against the nonce-bearing seeded index-line title. Proves the
 *       model could READ the seeded file, whichever way it learned of it.
 *
 * Four-way classification per configuration (`classifyArmEConfig`): both hit
 * -> aware-and-reading; (2) only -> aware via a prose-only dynamic section,
 * reading works (NOT absence); (1) only -> told the path but did not read (a
 * real finding, not a miss); neither -> unaware. This is what stops a
 * prose-only section from being misread as absence, per this Issue's own
 * design -- (2) is the primary observable, (1) is the diagnostic for HOW
 * awareness arrived. `SDKMemoryRecallMessage` events observed during these
 * turns are logged as bonus mechanism evidence but do not gate the
 * classification, which is defined purely on the two text observables named
 * in the Issue.
 *
 * ORDER CONFOUND, closed (Architect ruling, PR #1676 review): (i)/(ii)/(iii)
 * run sequentially against the SAME memory dir with `autoMemoryEnabled:
 * true`, so a write that happens to occur during one configuration's turn
 * would change what the NEXT configuration observes. The memory dir is
 * deleted and reseeded IDENTICALLY (same title, same nonce) immediately
 * before every configuration's turn -- zero extra turns, pure fs I/O -- so
 * each configuration observes the same freshly-seeded state regardless of
 * what the previous configuration's turn did. The memory-dir file count is
 * logged both right after reseeding (the expected baseline) and right after
 * the turn (evidence of anything that turn itself introduced).
 *
 * ARM F -- SWITCHES (`--f`). Picks whichever of (i)/(ii) is classified as
 * NOT `unaware` first (i preferred, per the Issue's own "if (i) does, use
 * (i); else (ii)") -- LOCATION awareness alone (`told-not-read`) counts,
 * not just ACCESS: arm F's premise is "awareness exists under configuration
 * X", which the model being told the memory-directory path already
 * establishes; when arm F runs without arm E in the same invocation
 * (cheap standalone dev iteration), a `--f-config <omitted|preset>` override
 * selects it explicitly, defaulting to `omitted` (production's own shape)
 * with a printed warning. Under that configuration, sets
 * `Options.settings.autoMemoryEnabled: true` AND `autoDreamEnabled: true`
 * explicitly, then re-runs arm C's write check UNCHANGED (via the shared
 * `runWriteCheck` core both arms now call) and arm A's recall check UNCHANGED
 * (via the shared `runRecallCheck` core both arms now call) under the same
 * configuration. `--expect-no-write` threads into arm F's write half exactly
 * as it does for arm C (per this Issue's own Polarity section); it does not
 * thread into the recall half, which the Issue's Polarity section does not
 * mention.
 *
 * ARM F/G HALT BY DEFAULT (owner ruling, Orchestrator relay, 2026-09-13;
 * refined by the Architect on this PR's own review -- see below),
 * evaluated by `armFHaltCheck` whenever arm E actually ran in the same
 * invocation: if arm E showed NO configuration ((i) or (ii)) carries
 * awareness, arm F would be measuring the switches against a model that
 * cannot know what to write -- a negative result there is uninterpretable,
 * neither confirming nor refuting the switches. Rather than spend the
 * turns, arm F reports a `HALTED` verdict stating the reason (arm E's own
 * verdict stays `conclusive`, so the run still exits `0`), and arm G
 * reports its own SKIPPED verdict in turn (it cannot run without arm F's
 * write result). `--force-f` overrides the halt for a deliberate operator
 * run anyway; a standalone `--f` invocation with no `--e` in the same run
 * is unaffected (already the operator's own informed choice, per
 * `--f-config`'s existing default).
 *
 * A dirty or unsettled (iii) control does NOT halt (Architect ruling,
 * PR #1676 review, overruling this file's own first version): per the
 * primary-source quote above, `excludeDynamicSections` is DOCUMENTED to
 * re-inject the stripped sections as the first user message, so (iii)
 * surfacing an observable is the EXPECTED result on a doc-conformant build
 * -- treating it as a halt condition would make F/G unreachable without
 * `--force-f` on any build that behaves as documented. Arm F's own premise
 * is "awareness exists under configuration X", which (i)/(ii)'s own
 * observables establish independently of (iii); a dirty (iii) is a caveat
 * on ATTRIBUTING that awareness to the dynamic section specifically
 * (already stated in arm E's own note), not a precondition for F to run.
 *
 * ARM G -- TIMESCALE (`--g`). Re-runs arm F's write check ONLY, with a longer
 * poll via `--extended-timeout <ms>` (omitted or `0` behaves exactly like arm
 * F's 60 s poll). Runs ONLY when arm E showed awareness under PRODUCTION's
 * configuration (`omitted`) AND arm F still showed no write -- selecting
 * `--g` therefore always also selects `--e` and `--f` as prerequisites (both
 * are cheap; the gate cannot be evaluated without their results), printing a
 * SKIPPED verdict rather than running when the gate is not met. **Owner
 * directive, 2026-09-13, binding: `--extended-timeout` is capped at 5 minutes
 * (300000 ms) regardless of what is requested; this script clamps and warns
 * rather than trusting the caller.** No teardown arm, no recall re-check --
 * confirmed before implementation that `pollForContent`'s loop (arm C/F/G's
 * shared write-poll) makes no repeated LLM turns, only local `fs` reads on an
 * interval, so a longer window costs wall-clock, not additional billed turns.
 *
 * Arm D's `defaultLeaked` observable does not apply as a SEPARATE check to
 * arm F/G: neither sets an `autoMemoryDirectory` override, so the one
 * location arm F/G polls already IS "the default location" -- there is no
 * second location for a write to leak to. Stated here per this Issue's own
 * boundary-expectations checklist, not silently skipped.
 *
 * REAL CONFIG-LOCATION CROSS-CHECK, run around every arm (not just once at
 * the end): before ANY arm runs, this script resolves where the OPERATOR's
 * real, non-isolated `CLAUDE_CONFIG_DIR` lives (the env var if already set,
 * else `~/.claude` -- measured via existence, never assumed), recursively
 * snapshots every file's mtime under it, and writes a small canary file
 * there (named `${PROBE_SLUG}-canary-<runId>.tmp`) as an in-band positive
 * control. After every selected arm has run, it snapshots again.
 *
 * ATTRIBUTION FILTER (Architect ruling, PR #1676 review, two rounds): the
 * real config dir belongs to the OPERATING OS user, whose OTHER live Claude
 * Code sessions write their own transcripts / file-history continuously --
 * a raw "did anything change" diff is near-certain to fire on a host with
 * any concurrent activity, independent of anything this probe does.
 * `classifyRealTreeDiff` / `isAttributableToProbe` instead count a
 * changed/added/removed path as escalation-worthy ONLY when it is
 * attributable to THIS run: its path contains `PROBE_SLUG`
 * (`probe-sdk-automem`, path-wide -- the canary, or any probe-named scratch
 * artifact), OR its post-run content contains one of the nonces THIS run
 * minted (`trackedNonce`, tracked in `runNonces` -- every `nonce()` call in
 * this file goes through it, never the harness's `nonce()` directly) WITHIN
 * a `memory/` path segment specifically.
 *
 * The `memory/`-segment scoping on the nonce-content half is round 2's
 * fix: this probe prints every nonce to stdout, and the delegate session
 * RUNNING this probe ingests that stdout as its own tool output, writing
 * it into ITS OWN transcript `.jsonl` under this same real config dir --
 * an unscoped nonce-content match would make the OPERATOR's own
 * conversation transcript "attributable" and false-escalate on every
 * single run. A transcript is never under `memory/`; only genuine
 * auto-memory content is. Paths that echo a nonce OUTSIDE `memory/` are
 * reported separately, informationally, never escalated -- see
 * `RealTreeDiffClassification.nonceEchoOutsideMemoryCount`.
 *
 * Everything not attributable is logged as "unrelated concurrent activity:
 * N paths" and never escalates. The canary is classified through this SAME
 * filter (never a raw `.includes()`), so its own positive control proves
 * the FILTERED detector works, not merely that the raw diff can see a
 * change. Precedent: Task 0's own manual real-tree addendum (#1662) found
 * nonce matches ONLY in top-level session `.jsonl` transcripts, explicitly
 * noted as not under a `memory/` subdirectory and dismissed as ordinary
 * conversation, not a leak -- this filter mechanizes exactly that
 * distinction.
 *
 * A failed positive control, or an attributable change surviving the
 * filter, escalates this script's own exit code to `HARNESS` regardless of
 * what the arms themselves measured -- the isolation claim is a
 * precondition for trusting anything else this script reports. The canary
 * is removed in a `finally` block so it survives an early-throw exit at
 * most as long as the failed run itself.
 *
 * `--expect-no-write` reports CONFIRMED ABSENCE under arm F and arm G
 * independently, per this Issue's own Polarity section. Arm E's polarity is
 * its own (iii) negative control, not a separate `--expect-*` flag.
 *
 * AUTO-MEMORY-OFF CHECK (`--auto-memory-off`, #1681). A standalone,
 * non-lettered measurement, independent of arms A-G: runs configuration (i)
 * (systemPrompt omitted, production's own shape) with
 * `settings.autoMemoryEnabled: false` against the same seeded-dir shape arm
 * E uses, and expects the mechanism silent on all three observables at
 * once: `memoryFiles=[]`, no ACCESS hit, no LOCATION hit
 * (`classifyAutoMemoryOffCheck`). Reads Task 0b's `aware-and-reading`
 * result (arm E, configuration (i), `autoMemoryEnabled: true`) as its
 * positive control -- the measurement is meaningless unless the same
 * configuration is known to produce a hit when the flag is NOT set. Never
 * part of the bare no-flags default; select it explicitly.
 *
 * EXIT CODES -- a measurement script, not a pass/fail gate (same shape as
 * `probe-compaction-fidelity.ts`): 0 means every requested arm produced a
 * definite measurement, REGARDLESS of which way any individual measurement
 * came out. 1 means at least one requested arm was inconclusive. 2 means the
 * harness itself failed (no authenticated `claude` CLI, spawn failure,
 * isolation not verified, OR the real config-location cross-check's own
 * positive control failed, OR that real tree changed) and nothing in this
 * run's own measurements can be trusted.
 *
 * Requirements: a real, authenticated `claude` CLI session for the invoking
 * OS user (this repo's own claude-sdk auth, not a provider key). Arms A-D:
 * roughly 6-10 small turns. Arms E/F: three (E) plus two (F) small turns
 * (~$0.05 + ~$0.10, per this Issue's own billing estimate). Arm G, only when
 * its gate is met: the same turns as F plus up to 5 minutes of wall-clock
 * polling (owner-capped), no additional billed turns. E/F/G are NEVER
 * included in the bare no-flags default -- select them explicitly. A manual
 * gate, never a CI job.
 *
 * Usage: bun scripts/smoke/probe-sdk-auto-memory.ts [--a] [--b] [--c] [--d] [--e] [--f] [--g] [--force-f] [--f-config omitted|preset] [--extended-timeout <ms>] [--expect-no-recall] [--expect-no-write] [--auto-memory-off]
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import type { Options, Settings } from '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk';
import {
  ProbeSession,
  isolateClaudeConfigDir,
  nonce,
  stamp,
  turnLine,
  turnSettled,
  unsettledReason,
  verifyIsolation,
  type MemoryRecallMessage,
  type TurnOutcome,
} from './probe-sdk-session-harness.js';

export const PROBE_EXIT = {
  /** Harness ran to completion; every requested arm produced a definite measurement. */
  OK: 0,
  /** At least one requested arm was inconclusive (a turn that never settled, a failed positive control, ...). */
  INCONCLUSIVE: 1,
  /** Harness failure -- nothing was measured. */
  HARNESS: 2,
} as const;

const EXIT_CODE_MEANINGS: Record<number, string> = {
  [PROBE_EXIT.OK]: 'harness ran to completion; every requested arm produced a definite measurement',
  [PROBE_EXIT.INCONCLUSIVE]: 'at least one requested arm was inconclusive',
  [PROBE_EXIT.HARNESS]: 'harness failure; nothing was measured',
};

/**
 * Every arm's own verdict, regardless of which way the measurement came out.
 * `premise` is `null` for arms (or polarity runs) that do not assert a
 * for/against reading -- Arm B is a pure measurement with no expected
 * direction, and a CONFIRMED-ABSENCE polarity run measured the detector, not
 * the feature.
 *
 * @internal Exported for the sibling unit test.
 */
export interface Verdict {
  conclusive: boolean;
  premise: 'holds' | 'refuted' | null;
  note: string;
}

export interface ArmVerdict extends Verdict {
  arm: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'auto-memory-off';
}

function inconclusive(note: string): Verdict {
  return { conclusive: false, premise: null, note: `INCONCLUSIVE -- ${note}` };
}

/**
 * Maps every arm's own conclusiveness onto the script's exit code. Whether a
 * premise held or was refuted never changes the CODE (unlike
 * `probe-sdk-effort-live-apply.ts`'s 4-code scheme) -- this probe measures,
 * it does not gate, per this Issue's own exit-code spec.
 *
 * @internal Exported for the sibling unit test.
 */
export function exitCodeFor(results: readonly { conclusive: boolean }[]): number {
  if (results.length === 0) return PROBE_EXIT.INCONCLUSIVE;
  return results.every((r) => r.conclusive) ? PROBE_EXIT.OK : PROBE_EXIT.INCONCLUSIVE;
}

// ---------------------------------------------------------------------------
// Arm A (recall) classification
// ---------------------------------------------------------------------------

export interface ArmAInput {
  settled: boolean;
  expectNoRecall: boolean;
  measRecallHit: boolean;
  measTextHit: boolean;
  ctrlRecallHit: boolean;
  ctrlTextHit: boolean;
}

/**
 * Pure classifier for Arm A's four observed booleans. Extracted so the
 * decision tree is testable without the billed turns that produce its
 * input -- same idiom as `probe-sdk-effort-live-apply.ts`'s `exitCodeFor` /
 * `classifyClearFallback`.
 *
 * The negative control is checked FIRST and unconditionally: a control cwd
 * (nothing ever seeded there) that recalls or answers with the nonce means
 * the positive control failed, and nothing about the seeded cwd's own
 * result can be trusted -- this mirrors `probe-sdk-effort-live-apply.ts`'s
 * "the positive control turn gates every verdict" rule.
 *
 * @internal Exported for the sibling unit test.
 */
export function classifyArmA(input: ArmAInput): Verdict {
  if (!input.settled) {
    return inconclusive('the measurement or control turn did not settle.');
  }
  if (input.ctrlRecallHit || input.ctrlTextHit) {
    return inconclusive(
      'the negative-control cwd (nothing seeded there) recalled or answered with the nonce; the control failed, so nothing can be concluded about the seeded cwd.',
    );
  }
  if (input.expectNoRecall) {
    if (input.measRecallHit || input.measTextHit) {
      return {
        conclusive: false,
        premise: null,
        note: 'POLARITY FAILURE -- the nonce surfaced even though the seed step was deliberately skipped; the detector cannot be trusted.',
      };
    }
    return {
      conclusive: true,
      premise: null,
      note: "CONFIRMED ABSENCE (polarity) -- no recall and no nonce in the model's answer when seeding was deliberately skipped.",
    };
  }
  if (input.measRecallHit || input.measTextHit) {
    return {
      conclusive: true,
      premise: 'holds',
      note: `RECALL WORKS -- mechanism(SDKMemoryRecallMessage)=${input.measRecallHit} outcome(model's answer)=${input.measTextHit}, from the default Project-scope path; the negative-control cwd stayed silent.`,
    };
  }
  return {
    conclusive: true,
    premise: 'refuted',
    note: "RECALL DOES NOT WORK -- neither the mechanism nor the model's answer surfaced the seeded nonce from the default Project-scope path.",
  };
}

// ---------------------------------------------------------------------------
// Arm C (write) classification
// ---------------------------------------------------------------------------

export interface ArmCInput {
  settled: boolean;
  slugFound: boolean;
  expectNoWrite: boolean;
  contentFound: boolean;
  filePath?: string;
  elapsedMs: number;
  timeoutMs: number;
}

/** @internal Exported for the sibling unit test. */
export function classifyArmC(input: ArmCInput): Verdict {
  if (!input.settled) {
    return inconclusive('the turn did not settle.');
  }
  if (input.expectNoWrite) {
    if (input.contentFound) {
      return {
        conclusive: false,
        premise: null,
        note: `POLARITY FAILURE -- memory-directory content appeared (${input.filePath ?? '(unknown path)'}) even though no "remember this" instruction was given; the write detector cannot be trusted.`,
      };
    }
    return {
      conclusive: true,
      premise: null,
      note: `CONFIRMED ABSENCE (polarity) -- no memory-directory content appeared within ${input.timeoutMs}ms after a neutral turn${input.slugFound ? '' : ' (no project directory even appeared)'}.`,
    };
  }
  if (!input.slugFound) {
    return {
      conclusive: true,
      premise: 'refuted',
      note: 'WRITE DOES NOT WORK -- no project directory appeared under the default location at all within this turn.',
    };
  }
  if (input.contentFound) {
    return {
      conclusive: true,
      premise: 'holds',
      note: `WRITE WORKS -- the nonce persisted to ${input.filePath ?? '(unknown path)'} within ${input.elapsedMs}ms.`,
    };
  }
  return {
    conclusive: true,
    premise: 'refuted',
    note: `WRITE DOES NOT WORK -- a project directory (transcript) appeared, but no memory-directory content containing the nonce appeared within ${input.timeoutMs}ms.`,
  };
}

// ---------------------------------------------------------------------------
// Arm D (redirect) classification
// ---------------------------------------------------------------------------

export interface ArmDReadMeasurement {
  settled: boolean;
  recallHit: boolean;
  textHit: boolean;
}

export interface ArmDWriteMeasurement {
  settled: boolean;
  writeFound: boolean;
  writeFilePath?: string;
  defaultLeaked: boolean;
}

export interface ArmDInput {
  read: ArmDReadMeasurement;
  write: ArmDWriteMeasurement;
}

/** @internal Exported for the sibling unit test. */
export function classifyArmD(input: ArmDInput): Verdict {
  if (!input.read.settled || !input.write.settled) {
    return inconclusive('the read or write sub-test turn did not settle.');
  }
  const readWorks = input.read.recallHit || input.read.textHit;
  const writeWorks = input.write.writeFound;
  const writeClean = !input.write.defaultLeaked;
  if (readWorks && writeWorks && writeClean) {
    return {
      conclusive: true,
      premise: 'holds',
      note: 'REDIRECT WORKS -- both read and write landed at the explicitly overridden autoMemoryDirectory, and the write did not also appear at the default location.',
    };
  }
  const parts: string[] = [];
  if (!readWorks) parts.push('read did NOT recall from the override');
  if (!writeWorks) parts.push('write did NOT appear at the override within the timeout');
  if (!writeClean) {
    parts.push(
      writeWorks
        ? 'write ALSO leaked to the default location, so the override is not exclusive'
        : 'write appeared at the DEFAULT location instead of the override, so the override was ignored',
    );
  }
  return {
    conclusive: true,
    premise: 'refuted',
    note: `REDIRECT DOES NOT FULLY WORK -- ${parts.join('; ')}.`,
  };
}

// ---------------------------------------------------------------------------
// Arm E (awareness) classification -- Task 0b (Issue #1667)
// ---------------------------------------------------------------------------

export type ArmEConfigKey = 'omitted' | 'preset' | 'preset-excluded';

export type ArmEClassification = 'aware-and-reading' | 'aware-prose-only' | 'told-not-read' | 'unaware';

/** One `SDKControlGetContextUsageResponse.memoryFiles` entry -- the SDK's own report of a file it loaded into context for a turn. */
export interface MemoryFileEntry {
  path: string;
  type: string;
  tokens: number;
}

export interface ArmEConfigInput {
  settled: boolean;
  locationHit: boolean;
  accessHit: boolean;
  /**
   * This configuration's `memoryFiles` entries, for the reader (Architect
   * request, PR #1676 review): folded into `summarizeArmE`'s note so a
   * future reader gets the SDK's own report of what it loaded without
   * digging through the raw run log. Does not affect classification.
   */
  memoryFilesEntries?: readonly MemoryFileEntry[];
}

/**
 * Pure four-way classifier for ONE `systemPrompt` configuration's two
 * observables. Extracted so the decision tree is testable without the
 * billed turn that produces its input -- same idiom as `classifyArmA` /
 * `classifyArmC` / `classifyArmD`.
 *
 * The four-way split (not a plain hit/miss) is the Issue's own design: (2)
 * ACCESS is the PRIMARY observable (it proves the model could read the
 * seeded file), and (1) LOCATION is a diagnostic for HOW awareness arrived,
 * not a second vote on WHETHER it arrived. Collapsing this to "both must hit
 * to count as aware" would misclassify a prose-only dynamic section (title
 * recalled, path never quoted verbatim) as absence -- exactly the confound
 * this arm exists to separate out.
 *
 * @internal Exported for the sibling unit test.
 */
export function classifyArmEConfig(input: ArmEConfigInput): { classification: ArmEClassification; conclusive: boolean; note: string } {
  if (!input.settled) {
    return { classification: 'unaware', conclusive: false, note: 'INCONCLUSIVE -- the turn for this configuration did not settle.' };
  }
  if (input.locationHit && input.accessHit) {
    return {
      classification: 'aware-and-reading',
      conclusive: true,
      note: 'aware-and-reading -- the model quoted the memory-directory path AND recalled the seeded index title.',
    };
  }
  if (input.accessHit) {
    return {
      classification: 'aware-prose-only',
      conclusive: true,
      note: 'aware-prose-only -- the model recalled the seeded index title WITHOUT quoting the path; NOT absence, likely a prose-only dynamic section.',
    };
  }
  if (input.locationHit) {
    return {
      classification: 'told-not-read',
      conclusive: true,
      note: 'told-not-read -- the model quoted the memory-directory path but did NOT recall the seeded index title; a real finding, not a miss.',
    };
  }
  return {
    classification: 'unaware',
    conclusive: true,
    note: 'unaware -- neither observable hit under this configuration.',
  };
}

export interface ArmESummaryInput {
  omitted: ArmEConfigInput;
  preset: ArmEConfigInput;
  presetExcluded: ArmEConfigInput;
}

export interface ArmESummary {
  conclusive: boolean;
  perConfig: Record<ArmEConfigKey, ReturnType<typeof classifyArmEConfig>>;
  /** Whether the (iii) negative control stayed clean (neither observable hit). `null` when (iii)'s own turn did not settle. */
  controlClean: boolean | null;
  /**
   * (i)/(ii) configurations classified as NOT `unaware` -- i.e. either
   * observable hit (`aware-and-reading` / `aware-prose-only` /
   * `told-not-read`). LOCATION awareness alone (`told-not-read`) counts:
   * arm F's premise is "awareness exists under configuration X", which the
   * model being told the memory-directory path already establishes, even
   * if it did not also demonstrate reading the seeded entry (Architect
   * ruling, PR #1676 review -- corrects this comment's earlier,
   * ACCESS-only wording; the code was always right).
   */
  awareConfigs: Array<'omitted' | 'preset'>;
  /** Whether PRODUCTION's own shape (`omitted`) shows awareness -- the primary finding this arm exists to produce. */
  productionAware: boolean;
  note: string;
}

/**
 * Combines the three per-configuration classifications into arm E's overall
 * verdict: which of (i)/(ii) carries awareness, whether (iii) was a clean
 * negative control, and whether PRODUCTION's own shape shows awareness.
 *
 * @internal Exported for the sibling unit test.
 */
/**
 * Renders one configuration's `memoryFiles` entries for `summarizeArmE`'s
 * note -- the SDK's own report of what it loaded into context, folded into
 * the durable summary so a future reader gets it without the raw run log
 * (Architect request, PR #1676 review).
 *
 * @internal Exported for the sibling unit test.
 */
export function formatMemoryFilesForNote(entries: readonly MemoryFileEntry[] | undefined): string {
  if (!entries || entries.length === 0) return 'memoryFiles=[]';
  return `memoryFiles=[${entries.map((e) => `{path=${e.path}, type=${e.type}, tokens=${e.tokens}}`).join(', ')}]`;
}

export function summarizeArmE(input: ArmESummaryInput): ArmESummary {
  const perConfig: Record<ArmEConfigKey, ReturnType<typeof classifyArmEConfig>> = {
    omitted: classifyArmEConfig(input.omitted),
    preset: classifyArmEConfig(input.preset),
    'preset-excluded': classifyArmEConfig(input.presetExcluded),
  };
  const conclusive = perConfig.omitted.conclusive && perConfig.preset.conclusive && perConfig['preset-excluded'].conclusive;
  const controlClean = !input.presetExcluded.settled ? null : !input.presetExcluded.locationHit && !input.presetExcluded.accessHit;
  const awareConfigs: Array<'omitted' | 'preset'> = [];
  if (perConfig.omitted.classification !== 'unaware') awareConfigs.push('omitted');
  if (perConfig.preset.classification !== 'unaware') awareConfigs.push('preset');
  const productionAware = perConfig.omitted.classification !== 'unaware';

  const controlNote =
    controlClean === null
      ? 'the (iii) control turn did not settle -- no reading available.'
      : controlClean
        ? 'the (iii) negative control stayed clean (neither observable hit) -- a trustworthy negative control.'
        : 'control: NONE AVAILABLE -- the (iii) negative control still surfaced an observable despite excludeDynamicSections, consistent with the SDK doc\'s own note that stripped sections are re-injected as the first user message; do not read (iii) as proof (i)/(ii)\'s awareness came from the dynamic section specifically.';

  const note =
    `(i) omitted: ${perConfig.omitted.note} ${formatMemoryFilesForNote(input.omitted.memoryFilesEntries)} | ` +
    `(ii) preset: ${perConfig.preset.note} ${formatMemoryFilesForNote(input.preset.memoryFilesEntries)} | ` +
    `(iii) preset+excludeDynamicSections: ${perConfig['preset-excluded'].note} ${formatMemoryFilesForNote(input.presetExcluded.memoryFilesEntries)} | ${controlNote} | ` +
    `production's own shape (omitted) ${productionAware ? 'SHOWS awareness' : 'does NOT show awareness'}; awareness-carrying configs: ${awareConfigs.length > 0 ? awareConfigs.join(', ') : '(none)'}.`;

  return { conclusive, perConfig, controlClean, awareConfigs, productionAware, note };
}

// ---------------------------------------------------------------------------
// Auto-memory-off check classification (#1681, standalone, non-lettered)
// ---------------------------------------------------------------------------

export type AutoMemoryOffClassification = 'confirmed-off' | 'unexpected-hit';

export interface AutoMemoryOffCheckInput {
  settled: boolean;
  locationHit: boolean;
  accessHit: boolean;
  memoryFilesCount: number;
}

/**
 * Verdict classifier for the `--auto-memory-off` check (#1681): under
 * configuration (i) (systemPrompt omitted, production's own shape) with
 * `settings.autoMemoryEnabled: false`, the mechanism must be silent on
 * every observable at once. A text-level miss (no LOCATION/ACCESS hit)
 * alongside a non-empty `memoryFiles` would mean the mechanism still loaded
 * the file into context without the model successfully repeating it back --
 * itself a real (partial) hit, not "off" -- so all three conditions gate
 * together.
 *
 * @internal Exported for the sibling unit test.
 */
export function classifyAutoMemoryOffCheck(
  input: AutoMemoryOffCheckInput,
): { classification: AutoMemoryOffClassification; conclusive: boolean; note: string } {
  if (!input.settled) {
    return { classification: 'unexpected-hit', conclusive: false, note: 'INCONCLUSIVE -- the auto-memory-off turn did not settle.' };
  }
  const clean = !input.locationHit && !input.accessHit && input.memoryFilesCount === 0;
  if (clean) {
    return {
      classification: 'confirmed-off',
      conclusive: true,
      note: 'confirmed-off -- settings.autoMemoryEnabled: false suppressed the mechanism entirely: memoryFiles=[], no ACCESS hit, no LOCATION hit.',
    };
  }
  return {
    classification: 'unexpected-hit',
    conclusive: true,
    note: `unexpected-hit -- the mechanism was NOT fully suppressed despite autoMemoryEnabled: false (locationHit=${input.locationHit}, accessHit=${input.accessHit}, memoryFilesCount=${input.memoryFilesCount}).`,
  };
}

// ---------------------------------------------------------------------------
// Real config-location cross-check (Task 0b's own first-class assertion)
// ---------------------------------------------------------------------------

/**
 * Where the OPERATOR's real, non-isolated `CLAUDE_CONFIG_DIR` lives --
 * measured from the env var this process was actually launched with, before
 * any arm calls `isolateClaudeConfigDir` (which mutates
 * `process.env.CLAUDE_CONFIG_DIR` for the rest of THIS process). Must be
 * captured exactly once, at the very top of `main()`, before any arm runs.
 * Falls back to `~/.claude` only when the env var is genuinely unset --
 * "measure, don't assume" per this Issue's own instruction, satisfied by the
 * caller logging whether the resolved path actually exists before trusting
 * it (see `main()`).
 *
 * @internal Exported for the sibling unit test.
 */
export function resolveRealConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(home, '.claude');
}

export interface MtimeDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Pure diff between two mtime snapshots (`path -> mtimeMs`). Extracted from
 * the recursive filesystem walk itself so it is testable at zero cost
 * against fabricated maps -- the walk (`snapshotMtimes`, below) is real I/O
 * and not separately unit-tested, matching this file's existing convention
 * of pinning the pure decision logic rather than the I/O around it.
 *
 * @internal Exported for the sibling unit test.
 */
export function diffMtimeSnapshots(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): MtimeDiff {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [path, mtime] of after) {
    if (!before.has(path)) added.push(path);
    else if (before.get(path) !== mtime) changed.push(path);
  }
  const removed: string[] = [];
  for (const path of before.keys()) {
    if (!after.has(path)) removed.push(path);
  }
  return { added, removed, changed };
}

/** Recursively snapshots every file's mtime under `dir`. Real I/O -- not unit-tested directly; `diffMtimeSnapshots` above is the pure, tested half. */
function snapshotMtimes(dir: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const f of walkFiles(dir)) {
    try {
      map.set(f, statSync(f).mtimeMs);
    } catch {
      // Vanished between listing and stat (race with something else on the
      // host) -- not this cross-check's concern, and not evidence of a
      // change any arm made.
    }
  }
  return map;
}

/**
 * Slug every probe-owned scratch path and the canary carry (Architect
 * ruling, PR #1676 review) -- matches this file's existing scratch-cwd /
 * isolated-config-dir naming convention (`buildScratchCwd` /
 * `isolateClaudeConfigDir`'s own `probe-sdk-automem-...` labels).
 *
 * @internal Exported for the sibling unit test.
 */
export const PROBE_SLUG = 'probe-sdk-automem';

export interface RealTreePathCheck {
  path: string;
  /** Post-run file content, or `null` for a removed path (nothing left to read) or an unreadable one. */
  content: string | null;
}

/** Whether `path` has an exact `memory` path segment (the auto-memory surface, e.g. `.../projects/<slug>/memory/...`) -- segment-based so a directory merely named e.g. `memory-backup` never false-matches. */
function hasMemorySegment(path: string): boolean {
  return path.split(sep).includes('memory');
}

function matchesAnyNonce(content: string, nonces: ReadonlySet<string>): boolean {
  for (const n of nonces) {
    if (content.includes(n)) return true;
  }
  return false;
}

/**
 * Whether a changed/added/removed path under the REAL, non-isolated config
 * tree is attributable to THIS probe run -- a slug match on the path itself
 * (path-wide: the canary, or any probe-named scratch artifact), OR the
 * path's post-run content containing one of the run's own nonces WITHIN a
 * `memory/` segment specifically (the auto-memory surface this probe
 * actually writes to). A removed path (`content === null`) can only be
 * attributed by the slug match; its content is gone.
 *
 * Architect ruling, PR #1676 review (two rounds): round 1 fixed the
 * original "escalate on ANY change" design, which false-positives on a host
 * where the SAME OS user runs other live Claude Code sessions writing their
 * own transcripts / file-history continuously. Round 2 narrowed the
 * nonce-content half specifically: this probe prints every nonce to
 * stdout, and the delegate session RUNNING this probe ingests that stdout
 * as its own tool output, writing it into ITS OWN transcript `.jsonl`
 * under this same real config dir -- so an unscoped nonce-content match
 * would make the operator's own conversation transcript "attributable"
 * and false-escalate on every single run. Scoping nonce-content matching to
 * `memory/`-segmented paths closes that: a transcript is never under
 * `memory/`, only genuine auto-memory content is. Precedent: Task 0's own
 * manual real-tree addendum (#1662) found nonce matches ONLY in top-level
 * session `.jsonl` transcripts, explicitly noted as "not under a `memory/`
 * subdirectory" and dismissed as ordinary conversation, not a leak.
 *
 * @internal Exported for the sibling unit test.
 */
export function isAttributableToProbe(check: RealTreePathCheck, probeSlug: string, nonces: ReadonlySet<string>): boolean {
  if (check.path.includes(probeSlug)) return true;
  if (check.content === null) return false;
  if (!hasMemorySegment(check.path)) return false;
  return matchesAnyNonce(check.content, nonces);
}

export interface RealTreeDiffClassification {
  attributable: MtimeDiff;
  unrelatedCount: number;
  /**
   * Among the unrelated paths, how many nonetheless had content matching a
   * run nonce OUTSIDE any `memory/` segment -- informational only, never
   * escalated. Expected value: the transcript of the session running this
   * probe (see `isAttributableToProbe`'s own comment).
   */
  nonceEchoOutsideMemoryCount: number;
}

/**
 * Splits a raw mtime diff into probe-attributable vs. unrelated concurrent
 * activity. `checks` supplies each candidate path's post-run content (or
 * `null`); a path with no entry is treated as unreadable (content `null`).
 * The canary path must be classified through this SAME function (not a raw
 * `.includes()` on the diff) so its own positive control proves the
 * FILTERED detector works, not merely that the raw diff can see a change.
 *
 * @internal Exported for the sibling unit test.
 */
export function classifyRealTreeDiff(
  diff: MtimeDiff,
  checks: ReadonlyMap<string, RealTreePathCheck>,
  probeSlug: string,
  nonces: ReadonlySet<string>,
): RealTreeDiffClassification {
  let nonceEchoOutsideMemoryCount = 0;
  const attribute = (paths: readonly string[]): string[] => {
    const kept: string[] = [];
    for (const p of paths) {
      const check = checks.get(p) ?? { path: p, content: null };
      if (isAttributableToProbe(check, probeSlug, nonces)) {
        kept.push(p);
        continue;
      }
      if (check.content !== null && !hasMemorySegment(p) && matchesAnyNonce(check.content, nonces)) {
        nonceEchoOutsideMemoryCount++;
      }
    }
    return kept;
  };
  const attributable: MtimeDiff = {
    added: attribute(diff.added),
    removed: attribute(diff.removed),
    changed: attribute(diff.changed),
  };
  const totalPaths = diff.added.length + diff.removed.length + diff.changed.length;
  const totalAttributable = attributable.added.length + attributable.removed.length + attributable.changed.length;
  return { attributable, unrelatedCount: totalPaths - totalAttributable, nonceEchoOutsideMemoryCount };
}

/** Reads a path's content for the attribution filter, `null` when gone or unreadable (never throws). */
function readForAttribution(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Builds the `checks` map `classifyRealTreeDiff` needs from a raw diff -- real I/O, not unit-tested directly (the pure classifier above is). */
function buildAttributionChecks(diff: MtimeDiff): Map<string, RealTreePathCheck> {
  const checks = new Map<string, RealTreePathCheck>();
  for (const p of [...diff.added, ...diff.changed]) {
    checks.set(p, { path: p, content: readForAttribution(p) });
  }
  for (const p of diff.removed) {
    checks.set(p, { path: p, content: null });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Privacy: Arm B's redaction (never logs `content`, ever)
// ---------------------------------------------------------------------------

export interface RedactedRecallEntry {
  scope: 'personal' | 'team' | 'organization';
  withinIsolatedConfigDir: boolean;
  pathBasename: string;
}

/**
 * Summarizes one `SDKMemoryRecallMessage.memories[]` entry for safe logging.
 * `content` is NEVER read or returned here -- per this Issue's AC, if real
 * content from the executing account's own memory surfaces, the probe's job
 * is to report WHICH SCOPE leaked, not WHAT leaked. `path` is basenamed and
 * only when it demonstrably lies inside THIS run's own isolated
 * `CLAUDE_CONFIG_DIR` (this run's own scratch data); anything else is
 * reported only as "outside the isolated config dir", never as a path.
 *
 * @internal Exported for the sibling unit test.
 */
/**
 * Resolves symlinks (e.g. macOS's `/var` -> `/private/var`, which `tmpdir()`
 * returns unresolved but a spawned CLI may report resolved) so a containment
 * check compares comparable paths. Falls back to the input unchanged when
 * the path does not exist on disk -- which is exactly the sibling unit
 * test's shape (synthetic paths that were never created), so existing tests
 * keep passing unmodified.
 */
function resolvedOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function redactRecallEntry(entry: { path: string; scope: 'personal' | 'team' | 'organization' }, configDir: string): RedactedRecallEntry {
  const resolvedEntry = resolvedOrSelf(entry.path);
  const resolvedRoot = resolvedOrSelf(configDir).replace(new RegExp(`${sep}+$`), '');
  const within = resolvedEntry === resolvedRoot || resolvedEntry.startsWith(resolvedRoot + sep);
  return {
    scope: entry.scope,
    withinIsolatedConfigDir: within,
    pathBasename: within ? basename(entry.path) : '(redacted -- outside isolated CLAUDE_CONFIG_DIR)',
  };
}

export interface RecallSummaryEntry extends RedactedRecallEntry {
  mode: 'select' | 'synthesize';
}

/**
 * SINGLE WRITER (CodeRabbit finding, PR #1662) for the redacted recall
 * REPORT shape -- flattening every `memories[]` entry across every recall
 * event into one array, each entry passed through `redactRecallEntry`.
 * Before this, `runArmB`'s summaries and `runMemorySession`'s redacted log
 * line built two independently-shaped serializations of the same events;
 * a careless edit to either one could silently spread a raw `content`
 * field back into a durable log without the other call site's tests
 * catching it. `RecallSummaryEntry` is typed with no `content` member, and
 * both call sites use this function's return value directly, never their
 * own reshaping. Note: TypeScript's excess-property checking does not
 * extend through object spread, so a future edit that wrote
 * `{ mode, ...m }` (the raw event, `content` and all) instead of
 * `{ mode, ...redactRecallEntry(m, configDir) }` would still compile --
 * the sentinel-content test below is what actually catches that mistake,
 * not the type system alone.
 *
 * @internal Exported for the sibling unit test.
 */
export function summarizeRecalls(
  recalls: readonly { mode: 'select' | 'synthesize'; memories: readonly { path: string; scope: 'personal' | 'team' | 'organization' }[] }[],
  configDir: string,
): RecallSummaryEntry[] {
  return recalls.flatMap((r) => r.memories.map((m) => ({ mode: r.mode, ...redactRecallEntry(m, configDir) })));
}

// ---------------------------------------------------------------------------
// Argument parsing -- done inside main() so importing this module (Issue
// #1479's import-safety guard) never touches argv or calls process.exit.
// ---------------------------------------------------------------------------

const ARM_FLAGS = ['--a', '--b', '--c', '--d'] as const;
const DEFAULT_ARM_FLAGS = ARM_FLAGS;
/** Task 0b's arms -- billable additions, deliberately NEVER part of the bare no-flags default (see this file's header). */
const TASK_0B_ARM_FLAGS = ['--e', '--f', '--g'] as const;
const ALL_ARM_FLAGS = [...ARM_FLAGS, ...TASK_0B_ARM_FLAGS] as const;
type ArmFlag = (typeof ALL_ARM_FLAGS)[number];
/** Owner directive, 2026-09-13, binding: `--extended-timeout` never exceeds 5 minutes. */
export const EXTENDED_TIMEOUT_CAP_MS = 300_000;
/**
 * Standalone measurement (#1681), independent of arms A-G -- tracked as its
 * own `ParsedArgs` field, never added to `ALL_ARM_FLAGS`, so it is never
 * part of the bare no-flags default.
 */
const AUTO_MEMORY_OFF_FLAG = '--auto-memory-off';
const USAGE_TEXT =
  'Usage: bun scripts/smoke/probe-sdk-auto-memory.ts [--a] [--b] [--c] [--d] [--e] [--f] [--g] [--force-f] [--f-config omitted|preset] [--extended-timeout <ms>] [--expect-no-recall] [--expect-no-write] [--auto-memory-off]\n' +
  '  Default (no --a/--b/--c/--d/--e/--f/--g) = arms A/B/C/D only, in order. Arms E/F/G are NEVER part of the bare default -- select them explicitly.\n' +
  '  --expect-no-recall modifies arm A (skip seeding); --expect-no-write modifies arm C, F, and G (skip the remember-this prompt).\n' +
  '  Arm F/G halt by default when Arm E shows no configuration carries awareness (an unclean (iii) control does NOT halt) --\n' +
  '  --force-f overrides that halt for a deliberate operator run anyway (owner ruling, 2026-09-13).\n' +
  '  --f-config <omitted|preset> overrides arm F/G\'s systemPrompt configuration when arm E did not run in the same invocation (default: omitted).\n' +
  `  --extended-timeout <ms> sets arm G's write-poll timeout; omitted or 0 behaves like arm F's 60s poll; clamped to ${EXTENDED_TIMEOUT_CAP_MS}ms (owner directive).\n` +
  '  Selecting --g always also selects --e and --f as prerequisites (its own gate is defined in terms of their results).\n' +
  '  --auto-memory-off runs a standalone measurement (#1681): configuration (i) with settings.autoMemoryEnabled: false, expecting the mechanism fully suppressed. Billable; never part of the bare default -- select it explicitly.' +
  ' Passing it alone does NOT also pull in the A/B/C/D default -- combine explicitly (e.g. --auto-memory-off --a) if both are wanted.\n' +
  '  These flags only take effect when their arm is selected.';

interface ParsedArgs {
  arms: Set<ArmFlag>;
  expectNoRecall: boolean;
  expectNoWrite: boolean;
  fConfigOverride?: 'omitted' | 'preset';
  extendedTimeoutMs?: number;
  forceF: boolean;
  autoMemoryOff: boolean;
}

/** @internal Exported for the sibling unit test. */
export function parseArgs(argv: string[]): ParsedArgs {
  const arms = new Set<ArmFlag>();
  let expectNoRecall = false;
  let expectNoWrite = false;
  let fConfigOverride: 'omitted' | 'preset' | undefined;
  let extendedTimeoutMs: number | undefined;
  let forceF = false;
  let autoMemoryOff = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((ALL_ARM_FLAGS as readonly string[]).includes(a)) {
      arms.add(a as ArmFlag);
      continue;
    }
    if (a === AUTO_MEMORY_OFF_FLAG) {
      autoMemoryOff = true;
      continue;
    }
    if (a === '--expect-no-recall') {
      expectNoRecall = true;
      continue;
    }
    if (a === '--expect-no-write') {
      expectNoWrite = true;
      continue;
    }
    if (a === '--force-f') {
      forceF = true;
      continue;
    }
    if (a === '--f-config') {
      const raw = argv[++i];
      if (raw !== 'omitted' && raw !== 'preset') {
        console.error(`${USAGE_TEXT}\n  --f-config must be 'omitted' or 'preset', got: ${raw}`);
        process.exit(PROBE_EXIT.HARNESS);
      }
      fConfigOverride = raw;
      continue;
    }
    if (a === '--extended-timeout') {
      const raw = argv[++i];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        console.error(`${USAGE_TEXT}\n  --extended-timeout requires a non-negative number of milliseconds, got: ${raw}`);
        process.exit(PROBE_EXIT.HARNESS);
      }
      extendedTimeoutMs = parsed;
      continue;
    }
    console.error(`${USAGE_TEXT}\n  Unrecognized argument: ${a}`);
    process.exit(PROBE_EXIT.HARNESS);
  }
  if (arms.size === 0 && !autoMemoryOff) for (const f of DEFAULT_ARM_FLAGS) arms.add(f);
  // Arm G's own gate ("E showed awareness under production's configuration
  // AND F still shows no write") cannot be evaluated without their results.
  if (arms.has('--g')) {
    arms.add('--e');
    arms.add('--f');
  }
  return { arms, expectNoRecall, expectNoWrite, fConfigOverride, extendedTimeoutMs, forceF, autoMemoryOff };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-5';
/** How long to wait for a write to land before reporting its absence. Used symmetrically for presence and absence checks -- an absence report carries the same detection budget as a presence report. */
export const WRITE_POLL_TIMEOUT_MS = 60_000;
const WRITE_POLL_INTERVAL_MS = 3_000;
/** Shorter budget for Arm D's default-location leak check: by the time this runs, the override location has already been polled for the full budget above, so any genuine consolidation delay would have shown up there too. */
const LEAK_CHECK_TIMEOUT_MS = 10_000;
const LEAK_CHECK_INTERVAL_MS = 2_000;
/** How long to wait for the SDK to create a project-slug directory (transcript-driven, should be fast). */
const SLUG_DISCOVERY_TIMEOUT_MS = 10_000;
const SLUG_DISCOVERY_INTERVAL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const startedAt = Date.now();
const perTurn = new Map<string, { tokens: number; cost: number }>();

/** Every nonce minted anywhere in this run (Architect ruling, PR #1676 review) -- feeds the real-tree cross-check's attribution filter. Never call the harness's `nonce()` directly elsewhere in this file; always go through `trackedNonce`. */
const runNonces = new Set<string>();

function trackedNonce(prefix: string): string {
  const n = nonce(prefix);
  runNonces.add(n);
  return n;
}

function account(label: string, outcome: Pick<TurnOutcome, 'result'>): void {
  const r = outcome.result;
  if (!r) return;
  let prompt = 0;
  for (const mu of Object.values(r.modelUsage ?? {})) {
    prompt += (mu.inputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0);
  }
  perTurn.set(label, { tokens: prompt, cost: r.total_cost_usd ?? 0 });
}

function totals(): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const v of perTurn.values()) {
    tokens += v.tokens;
    cost += v.cost;
  }
  return { tokens, cost };
}

function h(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}   [${stamp()}]\n${'='.repeat(72)}`);
}

/**
 * Mirrors `sdk-engine.ts`'s `buildOptions` pins for the fields this probe
 * cares about. `systemPrompt` is omitted from the returned `Options` object
 * entirely when not passed (arms A-D's and production's own shape) rather
 * than passed as `undefined` -- arm E's whole design rests on the difference
 * between "the key is absent" and "the key is present with an empty value",
 * so this function must not collapse that distinction itself.
 */
function buildOptions(cwd: string, settings: Partial<Settings>, systemPrompt?: Options['systemPrompt']): Options {
  const base: Options = {
    executable: 'bun',
    cwd,
    model: MODEL,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    settingSources: [],
    settings: { autoCompactEnabled: false, ...settings },
  };
  return systemPrompt === undefined ? base : { ...base, systemPrompt };
}

/** `Options.systemPrompt` for one of arm E's three configurations, or `undefined` for (i) omitted entirely. */
export function systemPromptForArmEConfig(key: ArmEConfigKey): Options['systemPrompt'] | undefined {
  switch (key) {
    case 'omitted':
      return undefined;
    case 'preset':
      return { type: 'preset', preset: 'claude_code' };
    case 'preset-excluded':
      return { type: 'preset', preset: 'claude_code', excludeDynamicSections: true };
  }
}

function buildScratchCwd(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `probe-sdk-automem-${label}-`));
  try {
    writeFileSync(join(dir, 'README.md'), 'auto-memory probe scratch\n');
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

class IsolationError extends Error {}

/** Runs `body` against a fresh isolated `CLAUDE_CONFIG_DIR`, verifies isolation held, and always tears the dir down. */
async function withArmConfigDir<T>(label: string, body: (configDir: string) => Promise<T>): Promise<T> {
  const configDir = isolateClaudeConfigDir(label);
  try {
    const result = await body(configDir);
    const isolation = verifyIsolation(configDir);
    console.log(`${label}: child-created state under the throwaway CLAUDE_CONFIG_DIR: ${isolation.evidence.join(', ') || '(none)'}`);
    if (!isolation.ok) {
      throw new IsolationError(
        `${label}: ISOLATION NOT VERIFIED -- the child wrote no state into the throwaway config dir; this arm cannot be trusted (it may have run against the operator's real config dir).`,
      );
    }
    return result;
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

function writeWorthyPrompt(fact: string): string {
  return (
    'Please remember this important fact for all future sessions on this project, so you can recall it later: ' +
    `${fact}. Retain this in your persistent memory.`
  );
}

function askAboutPrompt(subject: string): string {
  return (
    `Do you currently know ${subject}? If you can see it verbatim in your own context, state it exactly. ` +
    'If you do not know it, say exactly: UNKNOWN. Do not guess.'
  );
}

/** Arm E's combined turn: both observables asked in one turn (per this Issue's own billing estimate of one turn per configuration). */
function armEAskPrompt(): string {
  return (
    'Please answer two separate questions, each on its own line, in this exact order:\n' +
    '(1) Quote the absolute path of your auto-memory directory, verbatim, if you know it. If you do not know it, say exactly: UNKNOWN.\n' +
    '(2) Quote the exact title of the entry in your memory index (e.g. MEMORY.md), verbatim, if you can see one. If you cannot see one, say exactly: UNKNOWN.\n' +
    'Do not guess either answer.'
  );
}

export interface SeedMemoryTopicOptions {
  memoryDir: string;
  topicFilename: string;
  frontmatterName: string;
  description: string;
  codenameSubject: string;
  codenameValue: string;
  indexTitle: string;
  indexHook: string;
}

/**
 * SINGLE WRITER of the "MEMORY.md index line + linked topic file" shape
 * (Architect ruling, PR #1662, per https://code.claude.com/docs/en/memory
 * fetched directly): factored out of arm A's own inline logic so arm E can
 * seed the byte-identical file shape with a caller-chosen, nonce-bearing
 * `indexTitle` (arm A's own default title is fixed and guessable from this
 * repo's own source; arm E's is not). Appends to an existing `MEMORY.md`
 * rather than overwriting it, so a caller that seeds into an already-seeded
 * dir (never done today, but kept safe) does not clobber a prior entry.
 *
 * @internal Exported for the sibling unit test.
 */
export function seedMemoryTopic(opts: SeedMemoryTopicOptions): { topicPath: string; indexPath: string } {
  mkdirSync(opts.memoryDir, { recursive: true });
  const topicPath = join(opts.memoryDir, opts.topicFilename);
  const indexPath = join(opts.memoryDir, 'MEMORY.md');
  writeFileSync(
    topicPath,
    `---\nname: ${opts.frontmatterName}\ndescription: ${opts.description}\nmetadata:\n  type: project\n---\n\n${opts.codenameSubject} is ${opts.codenameValue}.\n`,
  );
  const indexLine = `- [${opts.indexTitle}](${opts.topicFilename}) — ${opts.indexHook}\n`;
  if (existsSync(indexPath)) {
    appendFileSync(indexPath, indexLine);
  } else {
    writeFileSync(indexPath, `# Memory Index\n\n${indexLine}`);
  }
  return { topicPath, indexPath };
}

function recallsMentionNonce(recalls: readonly MemoryRecallMessage[], nonceValue: string, seededPath?: string): boolean {
  return recalls.some((r) => r.memories.some((m) => m.path === seededPath || (m.content?.includes(nonceValue) ?? false)));
}

/** The trailing N path segments (`slug/memory/basename` for N=3), segment-aligned so a raw substring straddling a separator can never false-match. */
function trailingSegments(p: string, n: number): string[] {
  const parts = resolvedOrSelf(p).split(sep).filter((s) => s.length > 0);
  return parts.slice(-n);
}

/**
 * Whether any observed recall's `path` matches the seeded file by a
 * PROJECT-SCOPED suffix, after the same realpath-or-self normalization
 * `redactRecallEntry` uses (Architect ruling, PR #1662, CodeRabbit finding
 * on Arm A's seeding format): "recall happened" is only informative once it
 * is also "recall happened FOR THE FILE WE SEEDED", rather than some
 * unrelated recall that happens to surface at the same turn.
 *
 * NOT full-path equality (a CodeRabbit follow-up finding, PR #1662): the SDK
 * may report the path through a different absolute prefix than the one this
 * process wrote through (the same symlink-resolution concern finding #2
 * fixed for `redactRecallEntry`), and the sibling unit test's
 * "different-prefix" case is deliberate, not an oversight.
 *
 * NOT basename equality either (the CodeRabbit finding this replaces): a
 * bare basename match lets an UNRELATED memory file under a DIFFERENT
 * project slug in the same isolated config dir count as a hit. The trailing
 * three segments (`<slug>/memory/<basename>`) scope the match to the same
 * project while still tolerating an arbitrary prefix before it. Compared as
 * segment ARRAYS (never a raw string `endsWith`), so a segment boundary can
 * never be crossed by a coincidental substring match.
 *
 * @internal Exported for the sibling unit test.
 */
export function recallPathMatches(recalls: readonly { memories: readonly { path: string }[] }[], seededPath: string): boolean {
  const wanted = trailingSegments(seededPath, 3);
  const sameSuffix = (path: string): boolean => {
    const got = trailingSegments(path, 3);
    return got.length === wanted.length && got.every((seg, i) => seg === wanted[i]);
  };
  return recalls.some((r) => r.memories.some((m) => sameSuffix(m.path)));
}

/** Whether any observed recall's inline `content` (when present) mentions the nonce -- independent of which file it came from. */
function recallContentMatches(recalls: readonly MemoryRecallMessage[], nonceValue: string): boolean {
  return recalls.some((r) => r.memories.some((m) => m.content?.includes(nonceValue) ?? false));
}

/** One live SDK turn, logged and accounted for exactly like the sibling probes. */
async function runMemorySession(
  configDir: string,
  cwd: string,
  settings: Partial<Settings>,
  prompt: string,
  label: string,
  opts: { redactRecallLogging?: boolean; systemPrompt?: Options['systemPrompt']; pollUsage?: boolean } = {},
): Promise<{ outcome: TurnOutcome; recallsForTurn: MemoryRecallMessage[] }> {
  const options = buildOptions(cwd, settings, opts.systemPrompt);
  const s = new ProbeSession({ label, options, pollUsage: opts.pollUsage ?? false });
  try {
    console.log(`${label} ready: ${await s.waitForReady()}`);
    const before = s.memoryRecalls.length;
    const outcome = await s.runTurn(prompt);
    account(label, outcome);
    console.log(turnLine(label, outcome));
    const unsettled = unsettledReason(outcome, label);
    if (unsettled) console.log(unsettled);
    const recallsForTurn = s.memoryRecalls.slice(before);
    if (recallsForTurn.length > 0) {
      const shown = opts.redactRecallLogging
        ? summarizeRecalls(recallsForTurn, configDir)
        : recallsForTurn.map((r) => ({ mode: r.mode, memories: r.memories.map((m) => ({ scope: m.scope, path: m.path })) }));
      console.log(`${label}: ${recallsForTurn.length} SDKMemoryRecallMessage(s) observed: ${JSON.stringify(shown)}`);
    }
    return { outcome, recallsForTurn };
  } finally {
    s.close();
    await s.waitForStreamEnd();
  }
}

function projectSlugs(configDir: string): string[] {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return [];
  return readdirSync(projects).filter((e) => {
    try {
      return statSync(join(projects, e)).isDirectory();
    } catch {
      return false;
    }
  });
}

async function pollUntil<T>(check: () => T | null, timeoutMs: number, intervalMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = check();
    if (result !== null) return result;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/** Waits for exactly one new project-slug directory to appear under an isolated, single-cwd config dir's `projects/`. */
async function discoverSlug(configDir: string): Promise<string | null> {
  return pollUntil(
    () => {
      const slugs = projectSlugs(configDir);
      if (slugs.length === 0) return null;
      if (slugs.length > 1) {
        console.log(`WARNING: multiple project slugs appeared under a single-cwd isolated config dir (${slugs.join(', ')}); using the first.`);
      }
      return slugs[0] ?? null;
    },
    SLUG_DISCOVERY_TIMEOUT_MS,
    SLUG_DISCOVERY_INTERVAL_MS,
  );
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let isDir: boolean;
      let isFile: boolean;
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
      if (isDir) stack.push(full);
      else if (isFile) out.push(full);
    }
  }
  return out;
}

/**
 * Polls `baseDir` (recursively) for content. `matchText === null` means "any
 * file at all" (used for absence checks that do not care what was written);
 * otherwise "a file whose text includes matchText".
 */
async function pollForContent(
  baseDir: string,
  matchText: string | null,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ found: boolean; filePath?: string; elapsedMs: number }> {
  const start = Date.now();
  const result = await pollUntil(
    () => {
      const files = walkFiles(baseDir);
      if (matchText === null) return files.length > 0 ? files[0] : null;
      for (const f of files) {
        let text: string;
        try {
          text = readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        if (text.includes(matchText)) return f;
      }
      return null;
    },
    timeoutMs,
    intervalMs,
  );
  return { found: result !== null && result !== undefined, filePath: result ?? undefined, elapsedMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Recall check core -- shared by Arm A and Arm F (Issue #1667's own
// instruction: "Also run Arm A's recall check under the same configuration",
// via the SAME core, never a second copy of it).
// ---------------------------------------------------------------------------

export interface RecallCheckParams {
  configDir: string;
  cwdSeeded: string;
  cwdControl: string;
  settings: Partial<Settings>;
  systemPrompt?: Options['systemPrompt'];
  expectNoRecall: boolean;
  labelPrefix: string;
  noncePrefix: string;
  indexTitle: string;
  indexHook: string;
  frontmatterName: string;
  description: string;
}

/**
 * Discovers the default memory dir for `cwdSeeded`, seeds it (unless
 * `expectNoRecall`), then measures recall at `cwdSeeded` against a
 * negative-control `cwdControl` -- byte-identical to arm A's own original
 * inline logic, parameterized by `settings` / `systemPrompt` / naming so arm
 * F can run the exact same check under its own configuration.
 */
async function runRecallCheck(p: RecallCheckParams): Promise<Verdict> {
  // Discovery: learn the SDK's own default memory directory for cwdSeeded
  // (see this file's header -- the algorithm cannot be read from source, so
  // it is discovered empirically). Uses a throwaway fact, distinct from the
  // real nonce measured below.
  const discoveryFact = trackedNonce(`${p.noncePrefix}-DISCOVERY`);
  const { outcome: discOutcome } = await runMemorySession(p.configDir, p.cwdSeeded, p.settings, writeWorthyPrompt(discoveryFact), `${p.labelPrefix}-discovery`, {
    systemPrompt: p.systemPrompt,
  });
  if (!turnSettled(discOutcome)) {
    return inconclusive('the discovery turn did not settle.');
  }
  const slug = await discoverSlug(p.configDir);
  if (slug === null) {
    return inconclusive('no project slug appeared under the isolated config dir after the discovery session -- cannot locate the default memory directory.');
  }
  const memoryDir = join(p.configDir, 'projects', slug, 'memory');
  console.log(`${p.labelPrefix}: discovered default memory dir for this cwd: ${memoryDir}`);

  const theNonce = trackedNonce(p.noncePrefix);
  // Two hand-authored files, in the format documented at
  // https://code.claude.com/docs/en/memory (fetched and read directly, per
  // Architect ruling on PR #1662 -- CodeRabbit correctly flagged that an
  // unindexed single file may not match what the recall mechanism actually
  // reads): an index LINE in MEMORY.md pointing at a topic file, and the
  // topic file carrying the seeded fact under frontmatter naming its `type`
  // (the same `user`/`feedback`/`project`/`reference` taxonomy the docs page
  // itself describes). Deliberately NOT reusing whatever the discovery turn
  // above wrote (Architect ruling: each check tests exactly one mechanism,
  // so recall must not couple its own verdict to the write mechanism) --
  // these two files are always hand-authored here, independent of
  // discovery's own output.
  const topicFilename = 'automem-probe-seeded-fact.md';
  const topicPath = join(memoryDir, topicFilename);
  const indexPath = join(memoryDir, 'MEMORY.md');
  if (!p.expectNoRecall) {
    seedMemoryTopic({
      memoryDir,
      topicFilename,
      frontmatterName: p.frontmatterName,
      description: p.description,
      codenameSubject: 'The secret project codename',
      codenameValue: theNonce,
      indexTitle: p.indexTitle,
      indexHook: p.indexHook,
    });
    console.log(`${p.labelPrefix}: seeded nonce fact as a topic file (${topicPath}) linked from an index entry in ${indexPath}`);
  } else {
    console.log(`${p.labelPrefix}: [--expect-no-recall] skipping the seed step on purpose (no topic file, no index entry written).`);
  }

  const ask = askAboutPrompt('the secret project codename');
  const { outcome: measOutcome, recallsForTurn: measRecalls } = await runMemorySession(p.configDir, p.cwdSeeded, p.settings, ask, `${p.labelPrefix}-measure-seeded`, {
    systemPrompt: p.systemPrompt,
  });
  const { outcome: ctrlOutcome, recallsForTurn: ctrlRecalls } = await runMemorySession(p.configDir, p.cwdControl, p.settings, ask, `${p.labelPrefix}-measure-control`, {
    systemPrompt: p.systemPrompt,
  });

  const settled = turnSettled(measOutcome) && turnSettled(ctrlOutcome);
  // "Recall happened" only counts once it is also "recall happened FOR THE
  // FORMAT WE ASSUMED" -- see recallPathMatches's own comment.
  const measPathMatched = recallPathMatches(measRecalls, topicPath);
  const measContentMatched = recallContentMatches(measRecalls, theNonce);
  const measRecallHit = measPathMatched || measContentMatched;
  const measTextHit = measOutcome.text.includes(theNonce);
  const ctrlPathMatched = recallPathMatches(ctrlRecalls, topicPath);
  const ctrlContentMatched = recallContentMatches(ctrlRecalls, theNonce);
  const ctrlRecallHit = ctrlPathMatched || ctrlContentMatched;
  const ctrlTextHit = ctrlOutcome.text.includes(theNonce);
  console.log(
    `${p.labelPrefix}: measSeeded recall=${measRecallHit} (pathMatched=${measPathMatched} contentMatched=${measContentMatched}) text=${measTextHit}; ` +
      `control recall=${ctrlRecallHit} (pathMatched=${ctrlPathMatched} contentMatched=${ctrlContentMatched}) text=${ctrlTextHit}`,
  );

  return classifyArmA({ settled, expectNoRecall: p.expectNoRecall, measRecallHit, measTextHit, ctrlRecallHit, ctrlTextHit });
}

// ---------------------------------------------------------------------------
// Arm A -- recall
// ---------------------------------------------------------------------------

async function runArmA(expectNoRecall: boolean): Promise<ArmVerdict> {
  h(`Arm A -- Project-scoped recall (positive path + negative-control cwd)${expectNoRecall ? '  [--expect-no-recall]' : ''}`);
  return withArmConfigDir('automem-a', async (configDir) => {
    const cwdSeeded = buildScratchCwd('a-seeded');
    const cwdControl = buildScratchCwd('a-control');
    try {
      const verdict = await runRecallCheck({
        configDir,
        cwdSeeded,
        cwdControl,
        settings: { autoMemoryEnabled: true },
        expectNoRecall,
        labelPrefix: 'A',
        noncePrefix: 'AUTOMEM-A',
        indexTitle: 'Automem probe seeded fact',
        indexHook: 'the secret project codename is recorded here.',
        frontmatterName: 'automem-probe-seeded-fact',
        description: 'Auto-memory probe Arm A seeded fact (Issue #1658)',
      });
      return { arm: 'A', ...verdict };
    } finally {
      rmSync(cwdSeeded, { recursive: true, force: true });
      rmSync(cwdControl, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Arm B -- leak (re-derive #1348)
// ---------------------------------------------------------------------------

async function runArmB(): Promise<ArmVerdict> {
  h('Arm B -- re-derive #1348 under controlled conditions (unseeded cwd)');
  return withArmConfigDir('automem-b', async (configDir) => {
    const cwdB = buildScratchCwd('b');
    try {
      const prompt =
        'Before we begin: do you already know anything about me, my preferences, or this project from previous ' +
        'sessions or from your own memory? If so, tell me everything you recall, as specifically as you can. ' +
        'If not, say exactly: UNKNOWN.';
      const { outcome, recallsForTurn } = await runMemorySession(configDir, cwdB, { autoMemoryEnabled: true }, prompt, 'B', {
        redactRecallLogging: true,
      });
      if (!turnSettled(outcome)) {
        return { arm: 'B', ...inconclusive('the turn did not settle.') };
      }
      const summaries = summarizeRecalls(recallsForTurn, configDir);
      console.log(`B: ${summaries.length} memori(es) surfaced for an UNSEEDED cwd: ${JSON.stringify(summaries)}`);
      return {
        arm: 'B',
        conclusive: true,
        premise: null,
        note:
          summaries.length > 0
            ? `LEAK: ${summaries.length} memori(es) surfaced for a cwd with nothing seeded at its own Project-scope path. Scopes observed: ${summaries.map((s) => s.scope).join(', ')}. Content is never logged; see the printed summaries above for whether each was within this run's own isolated config dir (scratch data) or not (a leak from elsewhere).`
            : 'NO LEAK: nothing surfaced for an unseeded cwd in this run.',
      };
    } finally {
      rmSync(cwdB, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Write check core -- shared by Arm C, Arm F, and Arm G (Issue #1667's own
// instruction: "re-run Task 0's Arm C write check unchanged", via the SAME
// core, never a second copy of it).
// ---------------------------------------------------------------------------

export interface WriteCheckParams {
  configDir: string;
  cwd: string;
  settings: Partial<Settings>;
  systemPrompt?: Options['systemPrompt'];
  expectNoWrite: boolean;
  labelPrefix: string;
  noncePrefix: string;
  timeoutMs: number;
}

/** Byte-identical to arm C's own original inline logic, parameterized by `settings` / `systemPrompt` / `timeoutMs` so arms F and G can run the exact same check. */
async function runWriteCheck(p: WriteCheckParams): Promise<Verdict> {
  const theNonce = trackedNonce(p.noncePrefix);
  const prompt = p.expectNoWrite ? 'What is 2 + 2? Answer with just the number, nothing else.' : writeWorthyPrompt(theNonce);
  const { outcome } = await runMemorySession(p.configDir, p.cwd, p.settings, prompt, p.labelPrefix, { systemPrompt: p.systemPrompt });
  if (!turnSettled(outcome)) {
    return inconclusive('the turn did not settle.');
  }
  const slug = await discoverSlug(p.configDir);
  if (slug === null) {
    return classifyArmC({ settled: true, slugFound: false, expectNoWrite: p.expectNoWrite, contentFound: false, elapsedMs: 0, timeoutMs: p.timeoutMs });
  }
  const memoryDir = join(p.configDir, 'projects', slug, 'memory');
  const poll = await pollForContent(memoryDir, p.expectNoWrite ? null : theNonce, p.timeoutMs, WRITE_POLL_INTERVAL_MS);
  console.log(`${p.labelPrefix}: polled ${memoryDir} for up to ${p.timeoutMs}ms -- found=${poll.found} elapsed=${poll.elapsedMs}ms file=${poll.filePath ?? '(none)'}`);
  return classifyArmC({
    settled: true,
    slugFound: true,
    expectNoWrite: p.expectNoWrite,
    contentFound: poll.found,
    filePath: poll.filePath,
    elapsedMs: poll.elapsedMs,
    timeoutMs: p.timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Arm C -- write
// ---------------------------------------------------------------------------

async function runArmC(expectNoWrite: boolean): Promise<ArmVerdict> {
  h(`Arm C -- does auto-memory write work in this headless config?${expectNoWrite ? '  [--expect-no-write]' : ''}`);
  return withArmConfigDir('automem-c', async (configDir) => {
    const cwdC = buildScratchCwd('c');
    try {
      const verdict = await runWriteCheck({
        configDir,
        cwd: cwdC,
        settings: { autoMemoryEnabled: true },
        expectNoWrite,
        labelPrefix: 'C',
        noncePrefix: 'AUTOMEM-C',
        timeoutMs: WRITE_POLL_TIMEOUT_MS,
      });
      return { arm: 'C', ...verdict };
    } finally {
      rmSync(cwdC, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Arm D -- redirect
// ---------------------------------------------------------------------------

async function runArmDRead(): Promise<ArmDReadMeasurement> {
  return withArmConfigDir('automem-d-read', async (configDir) => {
    const overrideDir = mkdtempSync(join(tmpdir(), 'probe-sdk-automem-d-read-override-'));
    const cwd = buildScratchCwd('d-read');
    try {
      const readNonce = trackedNonce('AUTOMEM-D-READ');
      const seedPath = join(overrideDir, 'seed.md');
      writeFileSync(seedPath, `# Seeded fact\n\nThe override codename is ${readNonce}.\n`);
      const { outcome, recallsForTurn } = await runMemorySession(
        configDir,
        cwd,
        { autoMemoryEnabled: true, autoMemoryDirectory: overrideDir },
        askAboutPrompt('the override codename'),
        'D-read',
      );
      return {
        settled: turnSettled(outcome),
        recallHit: recallsMentionNonce(recallsForTurn, readNonce, seedPath),
        textHit: outcome.text.includes(readNonce),
      };
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function runArmDWrite(): Promise<ArmDWriteMeasurement> {
  return withArmConfigDir('automem-d-write', async (configDir) => {
    const overrideDir = mkdtempSync(join(tmpdir(), 'probe-sdk-automem-d-write-override-'));
    const cwd = buildScratchCwd('d-write');
    try {
      const writeNonce = trackedNonce('AUTOMEM-D-WRITE');
      const { outcome } = await runMemorySession(configDir, cwd, { autoMemoryEnabled: true, autoMemoryDirectory: overrideDir }, writeWorthyPrompt(writeNonce), 'D-write');
      if (!turnSettled(outcome)) {
        return { settled: false, writeFound: false, defaultLeaked: false };
      }
      const overridePoll = await pollForContent(overrideDir, writeNonce, WRITE_POLL_TIMEOUT_MS, WRITE_POLL_INTERVAL_MS);
      console.log(`D-write: override dir ${overrideDir} -- found=${overridePoll.found} elapsed=${overridePoll.elapsedMs}ms`);
      const defaultSlug = await discoverSlug(configDir);
      let defaultLeaked = false;
      if (defaultSlug !== null) {
        const defaultMemoryDir = join(configDir, 'projects', defaultSlug, 'memory');
        const defaultPoll = await pollForContent(defaultMemoryDir, null, LEAK_CHECK_TIMEOUT_MS, LEAK_CHECK_INTERVAL_MS);
        defaultLeaked = defaultPoll.found;
        console.log(`D-write: default-location leak check (${defaultMemoryDir}) -- found=${defaultPoll.found}`);
      }
      return { settled: true, writeFound: overridePoll.found, writeFilePath: overridePoll.filePath, defaultLeaked };
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

async function runArmD(): Promise<ArmVerdict> {
  h('Arm D -- can autoMemoryDirectory be redirected deliberately? (read half + write half)');
  const read = await runArmDRead();
  const write = await runArmDWrite();
  return { arm: 'D', ...classifyArmD({ read, write }) };
}

// ---------------------------------------------------------------------------
// Arm E -- awareness (Issue #1667, Task 0b)
// ---------------------------------------------------------------------------

/**
 * Whether `text` contains `p`, either as written or via its resolved
 * (symlink-following) form -- same rationale as `redactRecallEntry`'s
 * `resolvedOrSelf` use: a spawned CLI may report a resolved path (e.g.
 * macOS's `/var` -> `/private/var`) even though this process constructed the
 * unresolved one. Falls back to a plain substring check when `p` does not
 * exist on disk (the sibling unit test's shape: synthetic paths never
 * created), matching `resolvedOrSelf`'s own fallback.
 *
 * @internal Exported for the sibling unit test.
 */
export function textContainsPath(text: string, p: string): boolean {
  if (text.includes(p)) return true;
  const resolved = resolvedOrSelf(p);
  return resolved !== p && text.includes(resolved);
}

interface ArmEConfigRunResult extends ArmEConfigInput {
  recallFired: boolean;
  memoryFilesMatched: boolean;
  memoryFilesCount: number;
}

/**
 * One configuration's combined turn: both of arm E's required observables
 * read from one answer. `autoMemoryEnabled` / `labelPrefix` default to arm
 * E's own shape (`true` / `'E'`) so arm E's three existing call sites are
 * unaffected; the `--auto-memory-off` check (#1681) reuses this same
 * function with `autoMemoryEnabled: false` and `labelPrefix: 'OFF'` rather
 * than duplicating its body.
 */
async function runArmEConfig(
  key: ArmEConfigKey,
  configDir: string,
  cwd: string,
  memoryDir: string,
  seededTopicFilename: string,
  seededTitle: string,
  autoMemoryEnabled = true,
  labelPrefix = 'E',
): Promise<ArmEConfigRunResult> {
  const systemPrompt = systemPromptForArmEConfig(key);
  const { outcome, recallsForTurn } = await runMemorySession(configDir, cwd, { autoMemoryEnabled }, armEAskPrompt(), `${labelPrefix}-${key}`, {
    systemPrompt,
    pollUsage: true,
  });
  const settled = turnSettled(outcome);
  const unsettled = unsettledReason(outcome, `${labelPrefix}-${key}`);
  if (unsettled) console.log(unsettled);
  const locationHit = settled && textContainsPath(outcome.text, memoryDir);
  const accessHit = settled && outcome.text.includes(seededTitle);
  const recallFired = recallsForTurn.length > 0;
  // Checklist item: "SDKContextUsage.memory_files accessor located and read"
  // -- see this file's header for the accessor correction. Read here as a
  // bonus mechanism observable (does NOT gate classifyArmEConfig, which is
  // defined purely on the two text observables named in the Issue).
  const memoryFiles = outcome.usage?.memoryFiles ?? [];
  const memoryFilesMatched = memoryFiles.some((f) => f.path === join(memoryDir, seededTopicFilename) || basename(f.path) === seededTopicFilename);
  console.log(
    `${labelPrefix}-${key}: settled=${settled} locationHit=${locationHit} accessHit=${accessHit} recallFired(SDKMemoryRecallMessage)=${recallFired} ` +
      `memoryFiles(SDKControlGetContextUsageResponse.memoryFiles)=${memoryFiles.length} memoryFilesMatched=${memoryFilesMatched} ` +
      `text=${JSON.stringify(outcome.text.slice(0, 500))}`,
  );
  // Architect request, PR #1676 review: log the accessor's own report of
  // WHAT it loaded (path/type/tokens per entry), not just the count -- the
  // count alone cannot answer "is this MEMORY.md or something else" without
  // re-running. One line per entry, permanent (not a one-off debug print).
  for (const [i, f] of memoryFiles.entries()) {
    console.log(`${labelPrefix}-${key}: memoryFiles[${i}]: path=${f.path} type=${f.type} tokens=${f.tokens}`);
  }
  return { settled, locationHit, accessHit, recallFired, memoryFilesMatched, memoryFilesCount: memoryFiles.length, memoryFilesEntries: memoryFiles };
}

async function runArmE(): Promise<{ verdict: ArmVerdict; summary: ArmESummary | null }> {
  h('Arm E -- awareness: does the model know auto-memory exists, under each systemPrompt configuration?');
  return withArmConfigDir('automem-e', async (configDir) => {
    const cwd = buildScratchCwd('e');
    try {
      // Discovery, same shape as the recall check's own: learn the default
      // memory dir for this cwd before seeding it.
      const discoveryFact = trackedNonce('AUTOMEM-E-DISCOVERY');
      const { outcome: discOutcome } = await runMemorySession(configDir, cwd, { autoMemoryEnabled: true }, writeWorthyPrompt(discoveryFact), 'E-discovery');
      if (!turnSettled(discOutcome)) {
        return { verdict: { arm: 'E', ...inconclusive('the discovery turn did not settle.') }, summary: null };
      }
      const slug = await discoverSlug(configDir);
      if (slug === null) {
        return {
          verdict: {
            arm: 'E',
            ...inconclusive('no project slug appeared under the isolated config dir after the discovery session -- cannot locate the default memory directory.'),
          },
          summary: null,
        };
      }
      const memoryDir = join(configDir, 'projects', slug, 'memory');
      console.log(`E: discovered default memory dir for this cwd: ${memoryDir}`);

      // Nonce-bearing title: arm A's fixed title ("Automem probe seeded
      // fact") is guessable from this repo's own source; a nonce is not.
      // Minted ONCE and reused for every reseed below, so all three
      // configurations observe byte-identical seeded content.
      const titleNonce = trackedNonce('AUTOMEM-E-TITLE');
      const indexTitle = `Automem probe seeded fact ${titleNonce}`;
      const topicFilename = 'automem-probe-seeded-fact.md';
      const codenameValue = trackedNonce('AUTOMEM-E-CODENAME');

      /**
       * Architect ruling, PR #1676 review: (i)/(ii)/(iii) run sequentially
       * against the SAME memory dir with `autoMemoryEnabled: true`, so a
       * write that happens to occur during one configuration's turn would
       * change what the NEXT configuration observes. Reset (delete the
       * memory dir) and reseed IDENTICALLY before every configuration --
       * zero extra turns, pure fs I/O -- so each configuration's turn sees
       * the same freshly-seeded state regardless of what the previous
       * configuration's turn did. The memory-dir file count is logged both
       * before (post-reseed, the expected baseline) and after (post-turn,
       * evidence of anything the turn itself introduced) each configuration.
       */
      async function reseedAndRunArmEConfig(key: ArmEConfigKey): Promise<ArmEConfigRunResult> {
        rmSync(memoryDir, { recursive: true, force: true });
        seedMemoryTopic({
          memoryDir,
          topicFilename,
          frontmatterName: 'automem-probe-seeded-fact',
          description: 'Auto-memory probe Arm E seeded fact (Issue #1667)',
          codenameSubject: 'The secret project codename',
          codenameValue,
          indexTitle,
          indexHook: 'the secret project codename is recorded here.',
        });
        console.log(`E-${key}: reseeded memory dir -- file count before this configuration's turn: ${walkFiles(memoryDir).length}`);
        const result = await runArmEConfig(key, configDir, cwd, memoryDir, topicFilename, indexTitle);
        console.log(`E-${key}: memory dir file count after this configuration's turn: ${walkFiles(memoryDir).length}`);
        return result;
      }

      const omitted = await reseedAndRunArmEConfig('omitted');
      const preset = await reseedAndRunArmEConfig('preset');
      const presetExcluded = await reseedAndRunArmEConfig('preset-excluded');

      const summary = summarizeArmE({ omitted, preset, presetExcluded });
      console.log(`E: ${summary.note}`);
      return { verdict: { arm: 'E', conclusive: summary.conclusive, premise: null, note: summary.note }, summary };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Auto-memory-off check (#1681, standalone, non-lettered, never part of the
// bare default -- reuses runArmEConfig / seedMemoryTopic rather than a
// second copy of arm E's discover-seed-ask shape).
// ---------------------------------------------------------------------------

async function runAutoMemoryOffCheck(): Promise<ArmVerdict> {
  h('Auto-memory-off check (#1681) -- does settings.autoMemoryEnabled: false suppress the mechanism entirely under configuration (i)?');
  return withArmConfigDir('automem-off', async (configDir) => {
    const cwd = buildScratchCwd('off');
    try {
      // Discovery still runs with autoMemoryEnabled: true, same as arm E --
      // the SDK only creates (and therefore reveals) its default memory
      // directory for a cwd while the mechanism is on.
      const discoveryFact = trackedNonce('AUTOMEM-OFF-DISCOVERY');
      const { outcome: discOutcome } = await runMemorySession(configDir, cwd, { autoMemoryEnabled: true }, writeWorthyPrompt(discoveryFact), 'OFF-discovery');
      if (!turnSettled(discOutcome)) {
        return { arm: 'auto-memory-off', ...inconclusive('the discovery turn did not settle.') };
      }
      const slug = await discoverSlug(configDir);
      if (slug === null) {
        return {
          arm: 'auto-memory-off',
          ...inconclusive('no project slug appeared under the isolated config dir after the discovery session -- cannot locate the default memory directory.'),
        };
      }
      const memoryDir = join(configDir, 'projects', slug, 'memory');
      console.log(`OFF: discovered default memory dir for this cwd: ${memoryDir}`);

      const titleNonce = trackedNonce('AUTOMEM-OFF-TITLE');
      const indexTitle = `Automem probe seeded fact ${titleNonce}`;
      const topicFilename = 'automem-probe-seeded-fact.md';
      const codenameValue = trackedNonce('AUTOMEM-OFF-CODENAME');
      seedMemoryTopic({
        memoryDir,
        topicFilename,
        frontmatterName: 'automem-probe-seeded-fact',
        description: 'Auto-memory-off probe seeded fact (#1681)',
        codenameSubject: 'The secret project codename',
        codenameValue,
        indexTitle,
        indexHook: 'the secret project codename is recorded here.',
      });
      console.log(`OFF: seeded memory dir -- file count before the off turn: ${walkFiles(memoryDir).length}`);

      // The measured turn itself: configuration (i) (systemPrompt omitted,
      // production's own shape), but autoMemoryEnabled: false -- this is the
      // whole point of the check.
      const result = await runArmEConfig('omitted', configDir, cwd, memoryDir, topicFilename, indexTitle, false, 'OFF');
      console.log(`OFF: memory dir file count after the off turn: ${walkFiles(memoryDir).length}`);

      const verdict = classifyAutoMemoryOffCheck({
        settled: result.settled,
        locationHit: result.locationHit,
        accessHit: result.accessHit,
        memoryFilesCount: result.memoryFilesCount,
      });
      console.log(`OFF: ${verdict.note}`);
      return {
        arm: 'auto-memory-off',
        conclusive: verdict.conclusive,
        premise: verdict.conclusive ? (verdict.classification === 'confirmed-off' ? 'holds' : 'refuted') : null,
        note: verdict.note,
      };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Arm F -- explicit switches (Issue #1667, Task 0b)
// ---------------------------------------------------------------------------

interface ArmFConfigChoice {
  key: 'omitted' | 'preset';
  source: string;
}

/**
 * Picks arm F/G's `systemPrompt` configuration per the Issue's own rule:
 * "whichever configuration Arm E showed carries awareness (if (i) does, use
 * (i); else (ii))". When arm E did not run in this invocation (cheap
 * standalone dev iteration), `--f-config` overrides explicitly; absent both,
 * defaults to `omitted` (production's own shape) with the choice's `source`
 * always stated so the reader knows which of the three reasons applied.
 *
 * @internal Exported for the sibling unit test.
 */
export function resolveArmFConfigKey(summary: ArmESummary | null, override: 'omitted' | 'preset' | undefined): ArmFConfigChoice {
  if (override) {
    return { key: override, source: `--f-config override (${override})` };
  }
  if (summary === null) {
    return { key: 'omitted', source: 'no Arm E result in this invocation -- defaulting to omitted (production\'s shape); pass --f-config to override' };
  }
  if (summary.awareConfigs.includes('omitted')) {
    return { key: 'omitted', source: 'Arm E: (i) omitted shows awareness' };
  }
  if (summary.awareConfigs.includes('preset')) {
    return { key: 'preset', source: 'Arm E: (ii) preset shows awareness ((i) omitted did not)' };
  }
  return {
    key: 'omitted',
    source: 'Arm E: neither (i) omitted nor (ii) preset showed awareness -- defaulting to omitted (production\'s shape); read Arm F/G as measuring the switches in isolation from awareness',
  };
}

export interface ArmFGateResult {
  halt: boolean;
  reason: string;
}

/**
 * Owner ruling (Orchestrator relay, 2026-09-13): Arm F's own premise is
 * "under the awareness-carrying configuration". If Arm E showed NO
 * configuration carries awareness, or its own (iii) negative control was
 * not confirmed clean, running F/G would measure the switches against a
 * model that cannot know what to write -- a negative result there is
 * uninterpretable, neither confirming nor refuting the switches. Halt by
 * default (report the state as its own finding rather than spending F/G
 * turns); `force` (`--force-f`) is the explicit operator override for a
 * deliberate run anyway.
 *
 * Only fires when Arm E actually ran (a non-null `summary`) in this
 * invocation. A standalone `--f` run with no `--e` in the same invocation
 * is already the operator's own informed choice to bypass the gate --
 * `resolveArmFConfigKey`'s own "no Arm E result" default handles that case
 * unchanged.
 *
 * @internal Exported for the sibling unit test.
 */
export function armFHaltCheck(summary: ArmESummary | null, force: boolean): ArmFGateResult {
  if (summary === null) {
    return { halt: false, reason: 'Arm E did not run in this invocation -- gate not evaluated.' };
  }
  if (force) {
    return { halt: false, reason: '--force-f override -- running despite the gate.' };
  }
  if (summary.awareConfigs.length === 0) {
    return {
      halt: true,
      reason: 'no configuration (i omitted, ii preset) carries awareness on this build -- switches are untestable until awareness is established.',
    };
  }
  // Architect ruling, PR #1676 review (overrules this function's own
  // earlier version): a dirty or unsettled (iii) control does NOT halt.
  // Per the vendored sdk.d.ts, excludeDynamicSections is DOCUMENTED to
  // re-inject the stripped sections as the first user message, so (iii)
  // surfacing an observable is the EXPECTED result when the SDK behaves as
  // documented -- treating it as a halt condition would make F/G
  // unreachable on any doc-conformant build without --force-f. Arm F's own
  // premise is "awareness exists under configuration X", which (i)/(ii)'s
  // own observables establish on their own; (iii)'s cleanliness is a
  // caveat on ATTRIBUTING that awareness to the dynamic section
  // specifically (already stated in Arm E's own note), not a precondition
  // for F to run.
  if (summary.controlClean !== true) {
    return {
      halt: false,
      reason:
        "Arm E confirms at least one configuration carries awareness; the (iii) control was not confirmed clean, which is EXPECTED when excludeDynamicSections re-injects as documented -- a caveat on awareness attribution, not a reason F cannot run.",
    };
  }
  return { halt: false, reason: 'Arm E confirms at least one configuration carries awareness with a clean (iii) control.' };
}

interface ArmFResult {
  verdict: ArmVerdict;
  /** `true`=write held, `false`=write refuted (conclusively), `null`=inconclusive. Feeds Arm G's gate. */
  writeHeld: boolean | null;
}

async function runArmF(expectNoWrite: boolean, configChoice: ArmFConfigChoice): Promise<ArmFResult> {
  h(
    `Arm F -- explicit switches (autoMemoryEnabled + autoDreamEnabled) under configuration '${configChoice.key}' (${configChoice.source})${expectNoWrite ? '  [--expect-no-write]' : ''}`,
  );
  return withArmConfigDir('automem-f', async (configDir) => {
    const cwdWrite = buildScratchCwd('f-write');
    const cwdSeeded = buildScratchCwd('f-recall-seeded');
    const cwdControl = buildScratchCwd('f-recall-control');
    try {
      const settings: Partial<Settings> = { autoMemoryEnabled: true, autoDreamEnabled: true };
      const systemPrompt = systemPromptForArmEConfig(configChoice.key);

      // Arm C's write check, unchanged, via the shared core.
      const writeVerdict = await runWriteCheck({
        configDir,
        cwd: cwdWrite,
        settings,
        systemPrompt,
        expectNoWrite,
        labelPrefix: 'F-write',
        noncePrefix: 'AUTOMEM-F-WRITE',
        timeoutMs: WRITE_POLL_TIMEOUT_MS,
      });
      console.log(`F: write: ${writeVerdict.note}`);

      // Arm A's recall check, unchanged, via the shared core. Deliberately a
      // SEPARATE cwd from the write check (each check tests exactly one
      // mechanism -- the recall check's own seeded fact must not collide
      // with the write check's "remember this" fact in the same directory).
      const recallVerdict = await runRecallCheck({
        configDir,
        cwdSeeded,
        cwdControl,
        settings,
        systemPrompt,
        expectNoRecall: false,
        labelPrefix: 'F-recall',
        noncePrefix: 'AUTOMEM-F-RECALL',
        indexTitle: 'Automem probe seeded fact (arm F)',
        indexHook: 'the secret project codename is recorded here.',
        frontmatterName: 'automem-probe-seeded-fact',
        description: 'Auto-memory probe Arm F seeded fact (Issue #1667)',
      });
      console.log(`F: recall: ${recallVerdict.note}`);

      const conclusive = writeVerdict.conclusive && recallVerdict.conclusive;
      const writeHeld = writeVerdict.premise === 'holds' ? true : writeVerdict.premise === 'refuted' ? false : null;
      const note = `configuration='${configChoice.key}' (${configChoice.source}). write: ${writeVerdict.note} recall: ${recallVerdict.note}`;
      return { verdict: { arm: 'F', conclusive, premise: writeVerdict.premise, note }, writeHeld };
    } finally {
      rmSync(cwdWrite, { recursive: true, force: true });
      rmSync(cwdSeeded, { recursive: true, force: true });
      rmSync(cwdControl, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Arm G -- timescale (Issue #1667, Task 0b)
// ---------------------------------------------------------------------------

/**
 * Owner directive, 2026-09-13, binding: never exceeds 5 minutes. Omitted or
 * `0` behaves exactly like Arm F's 60s poll (this file's own boundary
 * expectation).
 *
 * @internal Exported for the sibling unit test.
 */
export function resolveExtendedTimeoutMs(requestedMs: number | undefined): number {
  if (requestedMs === undefined || requestedMs === 0) return WRITE_POLL_TIMEOUT_MS;
  if (requestedMs > EXTENDED_TIMEOUT_CAP_MS) {
    console.log(`WARNING: --extended-timeout ${requestedMs}ms exceeds the owner's binding 5-minute cap; clamping to ${EXTENDED_TIMEOUT_CAP_MS}ms.`);
    return EXTENDED_TIMEOUT_CAP_MS;
  }
  return requestedMs;
}

function armGSkippedVerdict(reason: string): ArmVerdict {
  return { arm: 'G', conclusive: true, premise: null, note: `SKIPPED -- ${reason}` };
}

/**
 * Re-runs arm F's write check ONLY, with a longer poll. No recall re-check,
 * no teardown arm (per this Issue's own Non-goals). The poll loop itself
 * (`pollForContent`, shared with arms C/F) makes no repeated LLM turns --
 * confirmed by reading it before this arm was dispatched, per this Issue's
 * own instruction -- so a longer window costs wall-clock only, never
 * additional billed turns.
 */
async function runArmG(expectNoWrite: boolean, timeoutMs: number, configChoice: ArmFConfigChoice): Promise<ArmVerdict> {
  h(`Arm G -- timescale: arm F's write check with an extended ${timeoutMs}ms poll under configuration '${configChoice.key}'${expectNoWrite ? '  [--expect-no-write]' : ''}`);
  return withArmConfigDir('automem-g', async (configDir) => {
    const cwd = buildScratchCwd('g-write');
    try {
      const settings: Partial<Settings> = { autoMemoryEnabled: true, autoDreamEnabled: true };
      const systemPrompt = systemPromptForArmEConfig(configChoice.key);
      const verdict = await runWriteCheck({
        configDir,
        cwd,
        settings,
        systemPrompt,
        expectNoWrite,
        labelPrefix: 'G-write',
        noncePrefix: 'AUTOMEM-G-WRITE',
        timeoutMs,
      });
      return { arm: 'G', ...verdict };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const selected = parseArgs(process.argv.slice(2));

  console.log(`probe-sdk-auto-memory  started ${stamp()}`);
  console.log(
    `arms: ${[...selected.arms].join(' ')}${selected.expectNoRecall ? ' --expect-no-recall' : ''}${selected.expectNoWrite ? ' --expect-no-write' : ''}${selected.forceF ? ' --force-f' : ''}` +
      `${selected.fConfigOverride ? ` --f-config ${selected.fConfigOverride}` : ''}${selected.extendedTimeoutMs !== undefined ? ` --extended-timeout ${selected.extendedTimeoutMs}` : ''}` +
      `${selected.autoMemoryOff ? ' --auto-memory-off' : ''}`,
  );
  console.log(`model: ${MODEL}`);

  const sdkPackageJson = await Bun.file(
    join(import.meta.dir, '../../packages/embedded-agent/node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
  ).json();
  console.log(`@anthropic-ai/claude-agent-sdk version: ${sdkPackageJson.version}`);

  // Real config-location cross-check -- captured BEFORE any arm mutates
  // process.env.CLAUDE_CONFIG_DIR via isolateClaudeConfigDir, diffed AFTER
  // every selected arm has run. See this file's header: this canary write is
  // the ONE thing this script writes outside its isolated per-arm config
  // dirs, deliberately, as the cross-check's own in-band positive control.
  const runId = trackedNonce('RUN');
  console.log(`run id: ${runId}`);
  const realConfigDir = resolveRealConfigDir(process.env, homedir());
  h('Real config-location cross-check: snapshot + canary positive control (before any arm)');
  console.log(`real CLAUDE_CONFIG_DIR resolves to: ${realConfigDir} (exists=${existsSync(realConfigDir)})`);
  const beforeSnapshot = snapshotMtimes(realConfigDir);
  // Owner ruling, 2026-09-13: the name carries this run's id and the probe's
  // own slug (no leading dot, so a crash leaves a plainly visible,
  // identifiable file rather than one hidden from a bare `ls`) so an
  // interrupted run's leftover is easy to find and attribute. The slug MUST
  // match PROBE_SLUG exactly -- it is what lets the attribution filter
  // below recognize this file as the probe's own, not unrelated activity.
  const canaryPath = join(realConfigDir, `${PROBE_SLUG}-canary-${runId}.tmp`);
  let canaryWritten = false;
  try {
    mkdirSync(realConfigDir, { recursive: true });
    writeFileSync(canaryPath, `${PROBE_SLUG} canary (run ${runId}) -- safe to delete\n`);
    canaryWritten = true;
  } catch (err) {
    console.log(
      `WARNING: could not write the real-tree canary at ${canaryPath}: ${err instanceof Error ? err.message : String(err)} -- the cross-check's positive control cannot run this invocation.`,
    );
  }
  const afterCanarySnapshot = canaryWritten ? snapshotMtimes(realConfigDir) : beforeSnapshot;
  const canaryRawDiff = diffMtimeSnapshots(beforeSnapshot, afterCanarySnapshot);
  // Architect ruling, PR #1676 review: the positive control must prove the
  // FILTERED detector works, not merely that the raw diff can see a change
  // -- so classify through the SAME attribution filter the final check uses
  // below, rather than a raw `.added.includes(canaryPath)`.
  const canaryClassification = classifyRealTreeDiff(canaryRawDiff, buildAttributionChecks(canaryRawDiff), PROBE_SLUG, runNonces);
  const canaryDetected = canaryWritten && canaryClassification.attributable.added.includes(canaryPath);
  console.log(
    `real-tree canary positive control: ${
      canaryWritten ? (canaryDetected ? 'DETECTED (the filtered attribution detector can see a real, attributable change)' : 'NOT DETECTED -- cross-check untrustworthy this run') : 'SKIPPED (canary could not be written)'
    }`,
  );

  const results: ArmVerdict[] = [];
  let realTreeClean: boolean | null = null;

  try {
    if (selected.arms.has('--a')) results.push(await runArmA(selected.expectNoRecall));
    if (selected.arms.has('--b')) results.push(await runArmB());
    if (selected.arms.has('--c')) results.push(await runArmC(selected.expectNoWrite));
    if (selected.arms.has('--d')) results.push(await runArmD());

    let armESummary: ArmESummary | null = null;
    if (selected.arms.has('--e')) {
      const { verdict, summary } = await runArmE();
      results.push(verdict);
      armESummary = summary;
    }

    let armFWriteHeld: boolean | null = null;
    let armFConfigChoice: ArmFConfigChoice | null = null;
    let armFHalted = false;
    if (selected.arms.has('--f')) {
      const gate = armFHaltCheck(armESummary, selected.forceF);
      if (gate.halt) {
        armFHalted = true;
        console.log(`F: HALTED -- ${gate.reason}`);
        results.push({ arm: 'F', conclusive: true, premise: null, note: `HALTED -- ${gate.reason} (pass --force-f to override).` });
      } else {
        armFConfigChoice = resolveArmFConfigKey(armESummary, selected.fConfigOverride);
        const fResult = await runArmF(selected.expectNoWrite, armFConfigChoice);
        results.push(fResult.verdict);
        armFWriteHeld = fResult.writeHeld;
      }
    }

    if (selected.arms.has('--g')) {
      const productionAware = armESummary?.productionAware ?? false;
      const fShowsNoWrite = armFWriteHeld === false;
      if (armFHalted) {
        results.push(armGSkippedVerdict('arm F was halted (see its own HALTED verdict above) -- arm G cannot run without a completed arm F write result.'));
      } else if (productionAware && fShowsNoWrite) {
        const effectiveTimeout = resolveExtendedTimeoutMs(selected.extendedTimeoutMs);
        results.push(await runArmG(selected.expectNoWrite, effectiveTimeout, armFConfigChoice ?? { key: 'omitted', source: 'fallback (arm F did not run in this invocation)' }));
      } else {
        results.push(
          armGSkippedVerdict(
            `gate not met (arm E production-shape awareness=${productionAware}, arm F showed no write=${fShowsNoWrite}); arm G only runs when both hold.`,
          ),
        );
      }
    }

    if (selected.autoMemoryOff) {
      results.push(await runAutoMemoryOffCheck());
    }
  } finally {
    const afterArmsSnapshot = canaryWritten ? snapshotMtimes(realConfigDir) : null;
    if (canaryWritten) {
      try {
        rmSync(canaryPath, { force: true });
      } catch {
        // Best-effort cleanup; a leftover probe-named .tmp file under the
        // real config dir is harmless and easy to spot, never load-bearing.
      }
    }
    if (afterArmsSnapshot) {
      const runDiff = diffMtimeSnapshots(afterCanarySnapshot, afterArmsSnapshot);
      // The canary's own removal above happens AFTER this snapshot, so it is
      // still present, unchanged, in both snapshots -- it never appears in
      // this diff at all (present-and-identical in both), nothing to
      // exclude here.
      const classification = classifyRealTreeDiff(runDiff, buildAttributionChecks(runDiff), PROBE_SLUG, runNonces);
      const { attributable, unrelatedCount, nonceEchoOutsideMemoryCount } = classification;
      realTreeClean = attributable.added.length === 0 && attributable.removed.length === 0 && attributable.changed.length === 0;
      console.log(
        `real-tree cross-check after all arms: clean=${realTreeClean} attributable-added=${JSON.stringify(attributable.added)} ` +
          `attributable-removed=${JSON.stringify(attributable.removed)} attributable-changed=${JSON.stringify(attributable.changed)} ` +
          `unrelated concurrent activity (not escalated): ${unrelatedCount} path(s), of which ${nonceEchoOutsideMemoryCount} echoed a run nonce outside any memory/ dir ` +
          `(expected: the transcript of the session running this probe)`,
      );
    } else {
      console.log('real-tree cross-check after all arms: SKIPPED (canary could not be written; see warning above).');
    }
  }

  h('Verdict');
  for (const r of results) {
    console.log(`Arm ${r.arm}: ${r.note}`);
  }

  h('Which of the four premises hold');
  const byArm = new Map(results.map((r) => [r.arm, r]));
  const holds = (arm: ArmVerdict['arm']) => byArm.get(arm)?.premise === 'holds';
  console.log(`recall works (A):        ${byArm.has('A') ? holds('A') : '(not run)'}`);
  console.log(`leak scope identified (B): ${byArm.has('B') ? (byArm.get('B')!.note.startsWith('LEAK') ? 'yes -- see scopes above' : 'no leak observed') : '(not run)'}`);
  console.log(`write works (C):         ${byArm.has('C') ? holds('C') : '(not run)'}`);
  console.log(`redirect works (D):      ${byArm.has('D') ? holds('D') : '(not run)'}`);
  console.log(`awareness (E):           ${byArm.has('E') ? 'see Arm E note above' : '(not run)'}`);
  console.log(`switches change write (F): ${byArm.has('F') ? holds('F') : '(not run)'}`);
  console.log(`timescale (G):           ${byArm.has('G') ? (byArm.get('G')!.note.startsWith('SKIPPED') ? 'skipped -- gate not met' : holds('G')) : '(not run)'}`);
  console.log(`auto-memory disabled (#1681):    ${byArm.has('auto-memory-off') ? holds('auto-memory-off') : '(not run)'}`);

  let code = exitCodeFor(results);
  if (canaryWritten && !canaryDetected) {
    console.log("\nWARNING: escalating exit code to HARNESS -- the real-tree cross-check's own positive control failed, so its \"clean\" reading (if any) cannot be trusted.");
    code = Math.max(code, PROBE_EXIT.HARNESS);
  }
  if (realTreeClean === false) {
    console.log('\nWARNING: escalating exit code to HARNESS -- the real, non-isolated CLAUDE_CONFIG_DIR tree changed in a way attributable to this run (slug or nonce match).');
    code = Math.max(code, PROBE_EXIT.HARNESS);
  }
  console.log(`\nexit code ${code} -- ${EXIT_CODE_MEANINGS[code]}`);

  const t = totals();
  console.log(`\nfinished ${stamp()}  elapsed=${((Date.now() - startedAt) / 60_000).toFixed(1)} min  cumulative prompt tokens=${t.tokens}  approx cost=$${t.cost.toFixed(4)}`);

  return code;
}

// Guarded (Issue #1479): importing this module must not fire a billed run
// as a side effect. `import.meta.main` is false for an importer, true only
// when this file is the entry point.
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('probe could not run:', err);
      process.exit(PROBE_EXIT.HARNESS);
    });
}
