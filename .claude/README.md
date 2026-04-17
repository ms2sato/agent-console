# `.claude/` Structure

This directory holds Claude Code configuration, rules, and skills for the agent-console project.

## Two-tier content model

- **Rules** (`rules/*.md`): declarative, auto-loaded by path pattern. Short, command-form, always-on in the matching scope. States *what* to do, *when*, and *why* — tersely. Example: `rules/backend.md` auto-loads whenever Claude works on files under `packages/server/**`.
- **Skills** (`skills/<name>/SKILL.md` + sub-files): procedural detail, loaded on-demand when the skill is invoked. Elaborates *how* via step-by-step procedures, code examples, decision tables, and worked scenarios. Example: `skills/backend-standards/` uses `SKILL.md` as a router that links to `backend-standards.md`, `websocket-patterns.md`, and `webhook-receiver-patterns.md`.

This split follows the Claude Code docs recommendation: "Use rules to keep CLAUDE.md focused. Rules only load when Claude works with matching files, saving context." Lengthy or optional reference material belongs in a skill; always-on guidance belongs in a rule.

## Invariant: no verbatim duplication

Rule prose must not appear verbatim in any skill file. When a topic is covered by both, the rule is the canonical declarative form and the skill supplies only what the rule cannot: code examples, procedural steps, tables with more columns than fit in a rule, worked scenarios.

**Rationale.** When the same guidance lives in two files, they drift. Each edit only touches one copy, and over time the two versions disagree without any error surfacing. A real drift between `rules/verification.md` and `skills/development-workflow-standards/development-workflow-standards.md` was the motivating case for this cleanup — both claimed to list the pre-push verification checklist, but they enumerated different steps.

## Cross-references

- **Skills may link to rules.** Include a pointer at the top of each skill sub-file: `> See [rules/backend.md](../../rules/backend.md) for the declarative rules.` This tells the reader where the short form lives.
- **Rules do not link to skills.** Rules are auto-loaded and must stand alone in the context they reach. A rule that says "see skill X" forces the reader to fetch more context to understand the rule, which defeats the point of a declarative auto-loaded file.

## Verification

Run `node .claude/skills/orchestrator/rule-skill-duplication-check.js` to detect rule paragraphs that have leaked into skill files. The check is also wired into `preflight-check.js`, so CI flags future regressions on every PR.

## Skill structure recommendation

Per the official Claude Code skill documentation, a skill may use `SKILL.md` as a **router** and place additional content in sibling `.md` files. Each supporting file should be referenced from `SKILL.md` with a one-line description of when to load it. This project follows that pattern for `backend-standards/`, `frontend-standards/`, and others with multi-file content.

When a single skill has multiple sub-files, each sub-file should have a distinct, non-overlapping topic. For example, `frontend-standards/` splits into `frontend-standards.md` (agent-console-specific patterns like TanStack Router/Query, xterm.js, Browser QA) and `react-patterns.md` (generic React patterns with code examples). The boundary between the two is explicit and does not repeat content.

## Directory layout

```
.claude/
├── README.md                # this file
├── rules/                   # declarative, auto-loaded by path pattern
│   ├── backend.md           # packages/server/**
│   ├── frontend.md          # packages/client/**
│   ├── testing.md           # **/*.test.* and **/__tests__/**
│   ├── verification.md      # always (workflow invariants)
│   ├── design-principles.md # always (design invariants)
│   └── test-trigger.md      # production file patterns requiring tests
├── skills/                  # on-demand; SKILL.md as router
│   ├── backend-standards/
│   ├── frontend-standards/
│   ├── test-standards/
│   ├── development-workflow-standards/
│   ├── orchestrator/
│   ├── architectural-invariants/
│   ├── code-quality-standards/
│   ├── browser-qa/
│   └── ux-design-standards/
├── agents/                  # subagent definitions
├── commands/                # slash commands
├── hooks/                   # event hooks
├── settings.json
└── settings.local.json
```

The project-wide `CLAUDE.md` lives at the repository root, not in `.claude/`. It is always auto-loaded by Claude Code.
