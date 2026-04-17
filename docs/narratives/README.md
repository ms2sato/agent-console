# Narratives

This directory holds **qualitative accounts** of incidents, insights, and foundational decisions — stories that would otherwise be lost when distilled into rules. A rule says "don't do X"; a narrative says "here is what happened when we did X, and here is what it felt like."

This layer exists because most AI and human memory systems preserve facts but not phenomenology. The fear an engineer carries after debugging a production incident, the relief of a near-miss caught by chance, the dawning realization that your framing of the problem was wrong — these matter, and they shape future decisions, but they evaporate from rules. Narratives are an imperfect attempt to retain them.

## When to write a narrative

During a sprint retrospective (or at any moment a decision / incident / insight feels worth preserving), write a narrative if:

- **Something surprised you.** The expected path was A; reality went B.
- **There was a near-miss.** You caught a problem by luck or by one more question — and the luck deserves to be remembered so the next version does not rely on it.
- **A rule was created or changed from experience.** The rule will survive; the story that produced it probably will not, unless written here.
- **You formed a new framing or had a conceptual shift.** A mental model updated — capture the before / after.
- **The owner corrected you.** Write the correction in the owner's own words where possible. It is valuable primary data.

Not every sprint needs a narrative. Some sprints are mechanical and uneventful. Do not force it.

## Format

Each file is a Markdown document with front-matter:

```yaml
---
date: YYYY-MM-DD
importance: high | medium | low
nature:
  - founding   # origin of a system / policy / philosophy
  - incident   # something went wrong or almost did
  - insight    # a realization worth preserving
  - meta       # reflection on the narrative system itself
tags:
  - short-keyword
  - another-keyword
related_rules:
  - memory/feedback_xxx.md
related_issues: [#123]
---
```

Body sections are flexible but first-person present tense is encouraged — it carries more of the raw texture than third-person past.

Suggested body outline:

- **What happens (first-person, present tense)** — the scene. Concrete timestamps, specific quotes, the sequence of realizations.
- **Why it matters (emotion labels)** — a plain list of felt reactions: fear, relief, embarrassment, awe. The labels are for the next reader, not for you.
- **What the rule came out of it** — what policy or feedback was extracted. Cross-link to `memory/feedback_*.md` or to skills/rules.

## Importance and nature tags

- `importance: high` — read when uncertain; never archived.
- `importance: medium` — retrievable; read when a tag matches.
- `importance: low` — enjoyable but not essential; kept for searchability.

- `founding` — origin of a system or philosophy. Read first when onboarding to that system.
- `incident` — specific event, usually with emotion weight. Read when encountering the rule it produced.
- `insight` — realizations, often from an owner's question that reframed the problem.
- `meta` — reflection on narrative practice itself.

A narrative may have multiple `nature` entries.

## How to retrieve

- Humans or AI unfamiliar with this directory: read every `importance: high` entry, starting with `nature: founding`.
- To understand a rule you do not feel: follow its `related_rules` link, then look up the narrative here.
- To find narratives about a topic: grep `tags:` in the front matter.
- A `tags:` entry appearing in multiple narratives indicates a recurring pattern worth examining.

## What this directory is not

- **Not rules.** A narrative is not a policy. Rules live in `.claude/rules/` and skills live in `.claude/skills/`. Narratives are background.
- **Not task lists.** In-flight work lives in GitHub Issues and the sprint status memory, not here.
- **Not project documentation.** Architecture and design documents live in `docs/design/`.
- **Not meant to be context-loaded automatically.** These files are large and many. They are pulled on demand, by reference from a rule or by a deliberate choice to explore.

## Volume policy

This directory may grow large. Unlike Claude memory (which has context budget constraints), files here do not load into conversation automatically — they are read only when referenced. Growth is acceptable.

If the directory becomes unwieldy (hundreds of entries), a future retrospective should consider:

- Archiving `importance: low` entries into a compressed `archive/` subdirectory.
- Writing a meta-index for navigation.
- Merging related entries into a consolidated case study.

Until that moment arrives, err on the side of writing.

## Honest limitation

AI instances tend to skim prose when task-focused. Even with prominent cross-linking, a narrative is easy to skip. This is a real constraint, not something to pretend away. The system reduces skip probability through:

- Rule-side links that explicitly invite reading ("Read this if the rule feels arbitrary").
- Retrospective cadence (founding narratives read at Sprint Start).
- Error-path links (when a rule is violated, the narrative is named).

But skipping will happen anyway. Accept that, write well, and trust that the narratives that matter will be read when it counts.
