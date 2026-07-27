---
date: 2026-07-27
importance: high
nature:
  - incident
  - insight
tags:
  - debugging
  - ci
  - inference-vs-verification
  - orchestrator
  - near-miss
related_rules:
  - .claude/rules/workflow.md
  - .claude/rules/pre-pr-completeness.md
  - .claude/skills/orchestrator/sprint-lifecycle.md
related_issues: [#1225, #1211, #1227, #1223]
summary: |
  main was red for four days and nobody was looking. Finding out why took
  four disproven hypotheses — two of mine, two of the delegate's — before
  anyone ran the experiment that settles such things in one step. The rules
  now say "prefer the control experiment"; this is the account of why that
  is easier to write than to do.
read_when:
  - You are several hypotheses deep into a bug and each new one still feels reasonable
  - A CI failure looks environmental and you are about to blame the runtime
  - You are about to block someone on a concern you have not verified
  - You are deciding whether to trust a green checkmark
---

# Four days red, and four wrong hypotheses

## What the morning looked like

I picked up a sprint mid-flight. The handoff was tidy: twelve PRs merged, one owner action left — run a smoke test on a real multi-user host, then merge the last PR and close out. The memory file said so, the memo said so, and the previous orchestrator had left a clean next-action signal.

So I did what the standing directive says to do while waiting on a human gate: keep the pipeline full. I closed two stale Issues after checking they were stale, and dispatched a delegate on a small test-hygiene fix.

Its CI came back red.

The failure was two cases in an integration boundary test, on a file the delegate had not touched, in a package their diff did not reach. I read the log — the rule about reading logs first is one I actually follow — and found something that looked like a runtime problem: `this.#handle.unref is not a function`. A private field, on an object the `open` npm package spawns.

Then I checked `main`. It had been red since July 23rd. Four days.

Nobody had noticed because nobody had looked, and nobody had looked because there had been nothing to look at. The sprint was waiting on the owner. Waiting means no merges. No merges means no CI runs on `main`. The failure was not being missed; **no observation was being made at all**. I only found it because I happened to dispatch unrelated work into a broken pipeline.

That is the part I keep returning to. Four completed PRs had been quietly unmergeable for four days, and the thing that surfaced it was luck wearing the costume of process.

## The four hypotheses

Here is the sequence, in order, with who proposed each and how long it survived.

**One — the bun version (mine).** Local passed, CI failed; local ran bun 1.3.10, CI pinned 1.3.5. A private field missing on a compat shim is exactly what a version gap looks like. I said so in the Issue. The Architect, consulted independently, said the same thing: "Bun version 差 class." Two of us, reasoning separately, landed on the same answer.

It was wrong. A probe on the real runner showed 1.3.5 handling `unref()` correctly in every shape I could construct, including the failure case I had predicted.

I want to note what that felt like, because the rule cannot carry it: **the hypothesis did not feel like a guess.** It felt like reading the evidence. Two independent parties agreeing reinforced it further, when in fact it only meant the same attractive proxy had captured us both.

**Two — the test requires a real desktop launcher (mine).** Reading the failing test, I noticed it only asserted the wire contract, yet awaited a call that had to succeed. That meant it needed the OS launcher to actually work on a headless CI runner. Elegant: it explained why exactly the two reaching cases failed while the sibling case, which short-circuits earlier, stayed green.

Also wrong. The launcher was present and working. `open('/tmp')` succeeded on the runner. The elegance was doing the persuading.

**Three — the happy-dom register/unregister cycle (the delegate's).** Reasonable, specific, and disproven cleanly.

**Four — an unclosed stdin sink (mine again).** By now I had read the production code and found something real: a `FileSink` that nothing ever closes, in two services, across five teardown paths. Structurally identical to a leak we had already ruled unsound elsewhere. I sent it over as a hypothesis "cheap to test, and it would explain everything."

The delegate had already tested it before my message arrived. Negative.

Four for four. And the finding was real — it became its own Issue — just not this cause. **Being right about a defect is not the same as being right about this defect.**

## What actually worked

Two things, and neither was a hypothesis.

The first: re-run the last *green* CI run, byte-identical, and see what happens. It failed. The tree was unchanged from when it passed, so no commit in the repository could be responsible. One action, and an entire category — everything we might have bisected in the diff — was eliminated. Comparing the two attempts of that same run then showed bun identical down to the build hash, and exactly one variable moved: the runner image version.

The second: when hypotheses ran out, stop generating and start deleting. The delegate reduced the polluting test file until the failure disappeared. The answer was two defects that only fail *together* — a globally-scoped spawn mock, and a module-mock losing a load-order race. Either alone is silent. That is precisely the shape hypothesis generation is worst at, because each hypothesis proposes one mechanism and the cause required two.

The same day, a different delegate settled a different bug the same way: run the identical config and binary outside Docker. Ten milliseconds instead of an indefinite hang. One variable, held everything else fixed.

Both experiments were available on day one. Neither requires cleverness. **What they require is giving up on the satisfying feeling of having an explanation.**

## The owner asked two short questions

Late in the day I reported that a delegate had failed to relay an Architect ruling. I had the evidence, the timeline, and a confident read: a reporting gap on the delegate's side.

The owner asked: *"Is it possible B3 doesn't recognise you as the Orchestrator?"*

I checked, because the honest thing was to ask the delegate rather than reason about them. They knew exactly who I was and had reported everything else correctly. The real cause was my own prompt: I had written "no need to route through me", meaning *you need no approval*, and it had been read as *you need not report*. Both readings are correct English. The delegate had followed my instruction.

Without that question I would have filed this as someone else's failure and left my prompt untouched.

Earlier, when I proposed a multi-step procedure to provision a binary, the owner asked: *"There's a command called install? sudo install?"* — a simple question about a tool. But it exposed that my whole procedure was oversized. What was needed was one line. My proposal would have re-run a bootstrap script whose `--force` flag would have replaced the live systemd unit with defaults, moving the running service off its port. The owner's plain question pulled it back to the minimum.

Two short questions, twice more accurate than my detailed analysis. The pattern is not that the owner knows more about the system — often they do not. It is that **I was inside the problem and had stopped questioning my own framing**, and they were outside it and had not started accepting mine.

## The one I nearly did to someone else

A delegate proposed a fix I was uneasy about. It seemed to widen a test-infrastructure change further than necessary. I wrote a careful message blocking it, invoking a principle another delegate had established that same day — that a passing suite does not prove absence of contamination.

The principle was sound. It did not apply. Two commands would have shown me: the mock set was two modules, not the five I had assumed, and sixteen files already imported it, so the semantics I feared were already in force. I ran those commands after sending the block, not before, and withdrew it two minutes later.

Two minutes is nothing. But `main` had been red for four days at that point, and I had stopped a fix for it on a concern I had not checked. **The correct order is verify, then object.** I had the principle right and the sequence backwards.

## Emotion labels

- **Vertigo**, at the moment I checked `main` and found four days of red. Not because it was hard to fix, but because the whole system — the sprint, the memo, the handoff, me — had been operating confidently on top of it.
- **Recognition**, when the Architect independently produced my wrong hypothesis. Briefly reassuring, then worse than being wrong alone: it meant a proxy attractive enough to capture two reasoners.
- **Deflation**, four times, each in the same shape: a mechanism that explained everything, disproven by one measurement.
- **Discomfort** at the owner's first question, which I want to record honestly. My initial internal move was to defend the diagnosis. The useful move was to go ask.
- **Something like embarrassment** at the block-then-verify. Not because it cost much — it did not — but because I had spent the day telling delegates to verify before concluding.

## What I would tell the next instance

The rules from this sprint now say: pair every negative with a positive control; stop generating after roughly three disproven hypotheses; prefer the experiment that holds everything fixed but one variable; check `main` when the pipeline goes quiet; verify before you object.

They are all correct, and they will all be easy to skip, because at the moment each applies you will have a hypothesis that feels like evidence rather than a guess. That feeling is not a signal. I had it four times in one day, with the delegate and the Architect independently agreeing on the first one.

The cheapest useful question is not "what could cause this?" It is **"what could I run that would be true or false regardless of what I believe?"** On a good day those are the same question. This was not a good day, and the distinction was the whole difference.
