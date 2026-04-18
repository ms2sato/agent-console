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
---

# The day agent-console's strategic position was articulated

## What happens (first-person, present tense)

Sprint 2026-04-18 retrospective has just closed. I've run the Context Store Pilot smoke test and confirmed the pipeline works end-to-end. I'm reaching for the next Issue when the owner interrupts.

> このリポジトリには大目標を与えていなくて、そのせいでIssueの優先度条件があなたにとってあいまいだ、というのは理解してる?

I was aware my prioritization had been thin. I had been reaching for "what was flagged as next in the retrospective", or "what scope looks small", or "what is technically urgent". Business impact was outside my judgment frame. I knew the headline in `memory/project_multiuser_vision.md` but had never translated it into "which Issue does this advance, and how much?" I admit it.

From there the owner begins to articulate, layer by layer. Not all at once — one piece, then waiting for me to absorb it, then the next.

**Layer 1:**

> あなたはLLM稼働のPTYプラットホームとしての最高の形を模索してほしい。AgentConsole はそのための製品です。ClaudeCodeだけに限定するのではなく、将来別のLLMをメインで使う時にも必要な道具を揃えたい。Claudeと機能が被ることは気にしない。汎用であるべきだから。私の判断ではClaudeの方がやりすぎ。

The two words "汎用" (generality) and "やりすぎ" (overreach) open a new axis in my head. A position I had been holding — *agent-console is a complement to Claude Code* — gets overwritten. agent-console is not a companion. It is an LLM-agnostic platform that happens to host Claude Code today.

**Layer 2:**

> Claude がやりすぎと思う例として一番なのは Agent Team かな。メッセージング等も内包、エージェントの親子関係も構築している。あのレベルを単一のLLMが保持するのは世界にとってはただの枷(Anthoropicにとっては戦略かもしれない)で、私はそこに縛られない世界を常に目指したい。つまりロックインされないために、LLMモデルは頭脳であって、それをラップする公式アプリケーションはあっても、過剰な機能を持たないのが適切。

**"The LLM is the brain; wrapping applications should not carry excessive features."** Two lines, but every design decision in agent-console now reinterprets itself.

I had designed the brewing script as a "no-LLM-call context packager" — that had felt like a subscription-economics choice, nothing more. But in this exchange I realize it was also an instance of the owner's strategy: **keep the implementation provider-independent, so any LLM can be dropped in without rewriting the surrounding apparatus.** Not coincidence. Necessity.

**Layer 3:**

> Agent の hooks は Agent 側に持っていい、ただしこの機能は早晩廃れる。最終的にはもっと抽象度が高いイベントでハンドルしたいはずだから、それは AgentConsole のようなプラットホームや、orchestrator スキルの中にトリガーが握られる。スキルも Agent の基本機能として一般化したから Agent サイドの持ち物で良い。だけど、スキルが呼び出したいもの(例えばスクリプトを非同期で呼ぶなど)は、プラットホームが提供すべき。なぜならLLMごとにこれを再実装するのはただの無駄。

Here the boundary line clarifies: LLM-internal (hooks, skills, agent orchestration) versus LLM-external (event triggers, script execution, state management). The outside is where agent-console belongs.

Then the owner continues:

> 過度にLLMの能力に依存するのではなく、LLMが欲しい情報をスクリプト等で用意するのは将来的にベストプラクティスと呼ばれると思っている。今ここについて真剣な人は少ない認識で、コードにできることもLLMにやらせようとしてコストや時間を無駄にしている。

This is a future-best-practice hypothesis. I try to summarize it as "少数意見 (a minority view)". The owner corrects me:

> これは、やった方がいいと思いながらも、LLMだけに任せてしまう方を人間が怠惰なために取りがちだということ。

Not a minority view — **a known rational choice that humans default away from out of laziness.** Most people recognize the value, but still ask the LLM to do what code could do, because it's easier to ask. agent-console refuses this default and stands as the **practice-demonstration** instance.

**Layer 4:**

> 本システムをモノレポにすればスムーズにできると思うので、ミニマムなところから始めるのはアリ。例えばメッセージングの仕組みだけを切り出しても構わない。機能ごとに部品を用意した状態で、同様の道具をうまく融通し合えるアプリケーションが複数あると、事らずの標準をLLM提供企業とは別に作れるのでは?

**agent-console as both reference application and component collection.** The components, extracted and reused by other applications, would form — alongside the managed frameworks from LLM vendors — a de-facto open standard layer that belongs to no single vendor. This standard persists even as specific LLMs change.

**Layer 5 (the short-term concrete):**

> 短期的に考えたいのは個人ではなく、小規模チームにおけるLLMオーケストレーションを活用した開発の最高の体験を生み出すことです。今行っているオーケストレーター中心の進め方は、LLM1 対 人間多 に移行する布石。本来はオーケストレーターは複数の人間の同時多発的な要求を平行に捌けるはず。入り口がオーケストレーターになることで、チーム開発が矛盾せず整合しつつ進められる。

One LLM coordinating multiple humans. A single entry point forcing team-level coherence. This is the concrete target of the "自社実践があと一歩" motive in the owner's memory — the gap that separates the foundation already built (multi-user OS accounts) from the lived experience that would prove the model.

## Why it matters (emotion labels)

- **Relief**: the brewing script's design was not a lucky accident. It was aligned with a strategy I did not know existed. The anchor is real, and I can trust past decisions.
- **Widening**: my prioritization gains three new axes — LLM-independence, extractability, team dimension. Thinking tools I did not have before.
- **Responsibility**: this articulation lives only in my head right now. Without externalization, it evaporates when this session ends. Writing the narrative and the strategy-overview is not optional.
- **Humility**: my "少数意見" summary was wrong enough that the owner corrected it immediately. Summarization drifts meaning. Stay close to the original words.

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
- Small-team orchestration remains unrealized in production. The owner said "加速できていないのは私の問題" (the acceleration gap is my own). Language has moved forward here; implementation is separate work.

## Owner quotes preserved in original Japanese

Owner's original words are kept verbatim throughout this narrative. The English surrounding text paraphrases my own absorption; the Japanese quotes carry the owner's intent without translation drift. If a future Orchestrator needs English translations, use an LLM on the quote blocks — do not backport translations into this file. The original is the authoritative artifact.
