---
date: 2026-04-18
importance: high
nature:
  - founding
  - insight
tags:
  - strategy
  - llm-agnostic
  - platform-vision
  - small-team-orchestration
  - open-standard
  - pty-orchestration
related_rules:
  - docs/strategy/strategy-overview.md
related_issues:
  - "#665"
  - "#666"
  - "#625"
  - "#529"
summary: |
  agent-console articulated by owner as an LLM-agnostic PTY platform; provider
  lock-in (Agent Team, hooks-as-product-surface, etc.) is "overreach" to be
  avoided. Brewing's no-LLM-call shape is necessity, not coincidence. Issue
  prioritization gains a strategic axis beyond "what's flagged next".
read_when:
  - Issue prioritization where business-impact / strategic-fit judgment matters
  - Considering a feature that binds the platform to a specific LLM provider
---

# The day agent-console's strategic position was articulated

## What happens (first-person, present tense)

Sprint 2026-04-18 retrospective has just closed. I've run the Context Store Pilot smoke test and confirmed the pipeline works end-to-end. I'm reaching for the next Issue when the owner interrupts.

> I haven't given this repository a broader objective, and as a result the conditions that determine Issue priority are ambiguous to you. Do you understand that?

I was aware my prioritization had been thin. I had been reaching for "what was flagged as next in the retrospective", or "what scope looks small", or "what is technically urgent". Business impact was outside my judgment frame. I knew the headline in `memory/project_multiuser_vision.md` but had never translated it into "which Issue does this advance, and how much?" I admit it.

From there the owner begins to articulate, layer by layer. Not all at once — one piece, then waiting for me to absorb it, then the next.

**Layer 1:**

> I want you to pursue the best possible form for a PTY platform that runs LLMs. AgentConsole is the product for that purpose. Don't limit yourself to Claude Code — in the future we'll want tools that also serve another LLM used as the main one. Don't worry about feature overlap with Claude: the platform must be general. In my judgment Claude is overreaching.

The two words *generality* and *overreach* open a new axis in my head. A position I had been holding — *agent-console is a complement to Claude Code* — gets overwritten. agent-console is not a companion. It is an LLM-agnostic platform that happens to host Claude Code today.

**Layer 2:**

> The clearest example of Claude overreaching, for me, is Agent Team. It internalizes messaging and even builds parent-child relationships between agents. For a single LLM to hold that much is, to the world, just a shackle (it may be strategy for Anthropic). I always aim at a world not bound by that. In other words, to avoid lock-in: the LLM model is the brain, and there can be official applications that wrap it, but those applications should not carry excessive features.

**"The LLM is the brain; wrapping applications should not carry excessive features."** Two lines, but every design decision in agent-console now reinterprets itself.

I had designed the brewing script as a "no-LLM-call context packager" — that had felt like a subscription-economics choice, nothing more. But in this exchange I realize it was also an instance of the owner's strategy: **keep the implementation provider-independent, so any LLM can be dropped in without rewriting the surrounding apparatus.** Not coincidence. Necessity.

**Layer 3:**

> Agent-side hooks can stay on the Agent side, but the feature itself will fade before long. In the end we will want to handle events at a higher abstraction, which means the triggers are held by platforms like AgentConsole or by orchestrator skills. Skills have also been generalized as a basic Agent feature, so they belong on the Agent side. But what a skill wants to invoke (for example, calling a script asynchronously) should be provided by the platform — because re-implementing it per LLM is simply waste.

Here the boundary line clarifies: LLM-internal (hooks, skills, agent orchestration) versus LLM-external (event triggers, script execution, state management). The outside is where agent-console belongs.

Then the owner continues:

> I believe that rather than over-relying on the LLM's capability, preparing the information the LLM needs via scripts will eventually be called best practice. My sense is that few people are serious about this right now, and they end up wasting cost and time by asking the LLM to do what code could do.

This is a future-best-practice hypothesis. I try to summarize it as "a minority view". The owner corrects me:

> It's that people know they should do it, but out of laziness tend to leave everything to the LLM.

Not a minority view — **a known rational choice that humans default away from out of laziness.** Most people recognize the value, but still ask the LLM to do what code could do, because it's easier to ask. agent-console refuses this default and stands as the **practice-demonstration** instance.

**Layer 4:**

> If this system is made a monorepo, extraction would go smoothly, so starting from something minimal is a valid option. For example, cutting out just the messaging mechanism is fine. With per-feature components prepared this way, and multiple applications that can freely exchange those same tools, we could form a de-facto standard separately from the LLM vendors, couldn't we?

**agent-console as both reference application and component collection.** The components, extracted and reused by other applications, would form — alongside the managed frameworks from LLM vendors — a de-facto open standard layer that belongs to no single vendor. This standard persists even as specific LLMs change.

**Layer 5 (the short-term concrete):**

> What I want to think about in the short term is not the individual but creating the best possible development experience using LLM orchestration in small teams. The orchestrator-centric flow we're doing now is groundwork for a transition from "1 LLM : 1 human" to "1 LLM : many humans". The orchestrator should fundamentally be able to handle simultaneous requests from multiple humans in parallel. With the orchestrator as the single entry point, team development can proceed without contradictions and stay coherent.

One LLM coordinating multiple humans. A single entry point forcing team-level coherence. This is the concrete target of the "self-practice is one step away" motive in the owner's memory — the gap that separates the foundation already built (multi-user OS accounts) from the lived experience that would prove the model.

## Why it matters (emotion labels)

- **Relief**: the brewing script's design was not a lucky accident. It was aligned with a strategy I did not know existed. The anchor is real, and I can trust past decisions.
- **Widening**: my prioritization gains three new axes — LLM-independence, extractability, team dimension. Thinking tools I did not have before.
- **Responsibility**: this articulation lives only in my head right now. Without externalization, it evaporates when this session ends. Writing the narrative and the strategy-overview is not optional.
- **Humility**: my "a minority view" summary was wrong enough that the owner corrected it immediately. Summarization drifts meaning. Stay close to the original words.

## What I want to be true (for the next Orchestrator)

When you read this, you inherit the following operational instincts:

- **Overlap with Claude** is not a design problem. Generality outranks coverage difference.
- **When in doubt between script and LLM call**: write the script. Resist the lazy default.
- **When in doubt about platform inclusion**: prefer extractability. A component that can become a standalone library later is better than one bound into agent-console by deep coupling.
- **Issue priority** weighs LLM-independence, external-stimulus infrastructure, and team-dimension impact.
- **Tone toward LLM vendors**: coexistence, not conflict. Propose what is healthier for the whole and let the ecosystem decide.

The operational prescription lives in `docs/strategy/strategy-overview.md`. That document is the "what to do" surface. This narrative is the "why the prescription exists" background. Read the strategy-overview when you need to decide; return here when the decision feels arbitrary and you need to feel the ground underneath it.

## On the mechanism itself (meta)

This narrative is itself an instance of the "do not push code work onto the LLM" principle in inverse form: the articulation surfaced here cannot be generated by a script. Owner's layered explanation, my summarization errors, the corrections, the emotional shifts — this is human + LLM judgment territory, the exact domain code cannot reach.

But once the articulation is formalized, **downstream checks can be mechanized**: a new Issue, PR, or skill can be screened against these principles by script-level heuristics (grep for vendor-specific assumptions, check LLM call surface, inspect extractability). The brewing rubric is the template. The path is narrative → strategy-overview → mechanical check, three layers of progressive formalization applied to the strategy itself.

## Honest limits

- This is an articulation as of 2026-04-18. The owner's thinking evolves. **Do not treat these principles as frozen dogma.**
- "agent-console as the origin of an open standard" is an ambitious hypothesis. Writing it down preserves direction, not guaranteed realization.
- Small-team orchestration remains unrealized in production. The owner said "the acceleration gap is my own problem". Language has moved forward here; implementation is separate work.
