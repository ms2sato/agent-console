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

# agent-console の戦略的 position が言語化された日

## 今ここで何が起きているか (first-person, present)

Sprint 2026-04-18 retrospective を終えた直後、Context Store Pilot を smoke test で回し、動いていることを確認した。次 Issue を拾おうとしたとき、owner が問い直す。

> このリポジトリには大目標を与えていなくて、そのせいでIssueの優先度条件があなたにとってあいまいだ、というのは理解してる?

自分の優先度判断が薄かった自覚はあった。retrospective の「next」リストに乗っているか、scope が小さいか、技術的に緊急かで決めていた。「事業インパクト」は判断外。`memory/project_multiuser_vision.md` の headline を知っていても、それが「どの Issue を早めるか」に落ちていなかった。正直に認める。

そこから owner が段階的に articulate する。一度に全部ではなく、私が理解するのを確認しながら、層を重ねていく。

**第一層**:
> あなたはLLM稼働のPTYプラットホームとしての最高の形を模索してほしい。AgentConsole はそのための製品です。ClaudeCodeだけに限定するのではなく、将来別のLLMをメインで使う時にも必要な道具を揃えたい。Claudeと機能が被ることは気にしない。汎用であるべきだから。私の判断ではClaudeの方がやりすぎ。

「汎用」「やりすぎ」の二語が新しい軸を開いた。私の頭の中で **AgentConsole = Claude Code の補完** という誤った position が上書きされる。

**第二層**:
> Claude がやりすぎと思う例として一番なのは Agent Team かな。メッセージング等も内包、エージェントの親子関係も構築している。あのレベルを単一のLLMが保持するのは世界にとってはただの枷(Anthoropicにとっては戦略かもしれない)で、私はそこに縛られない世界を常に目指したい。つまりロックインされないために、LLMモデルは頭脳であって、それをラップする公式アプリケーションはあっても、過剰な機能を持たないのが適切。

**「LLM = 頭脳」「wrap する公式アプリは過剰機能を持たない」** — 短い 2 行だが、agent-console の全設計判断が再解釈される。

自分が brewing script を「LLM を呼ばない context packager」として設計したのは、経済原理 (サブスク auth 保持) に従っただけだった。だがこの対話の中で、それが owner の戦略 — **LLM provider 非依存を保ち、どの LLM に差し替えても動く平面** を維持する設計 — と一致していたと気付く。偶然ではなく必然だった。

**第三層**:
> Agent の hooks は Agent 側に持っていい、ただしこの機能は早晩廃れる。最終的にはもっと抽象度が高いイベントでハンドルしたいはずだから、それは AgentConsole のようなプラットホームや、orchestrator スキルの中にトリガーが握られる。スキルも Agent の基本機能として一般化したから Agent サイドの持ち物で良い。だけど、スキルが呼び出したいもの(例えばスクリプトを非同期で呼ぶなど)は、プラットホームが提供すべき。なぜならLLMごとにこれを再実装するのはただの無駄。

ここで **境界線が明確になる**: LLM 内部 (hooks, skills, agent orchestration) と LLM 外部 (事件契機、script 実行、state 管理) の分割線。外部側が AgentConsole の役割。

そして owner が続ける:

> 過度にLLMの能力に依存するのではなく、LLMが欲しい情報をスクリプト等で用意するのは将来的にベストプラクティスと呼ばれると思っている。今ここについて真剣な人は少ない認識で、コードにできることもLLMにやらせようとしてコストや時間を無駄にしている。

これは将来の best practice の仮説だ。「少数意見」と私は要約した。owner は訂正する:

> これは、やった方がいいと思いながらも、LLMだけに任せてしまう方を人間が怠惰なために取りがちだということ。

少数意見ではなく、怠惰 vs 合理性。多くの人は価値を認識していつつも、LLM に全部任せる楽な道を選びがち。agent-console はこの合理を **実践して見せる** 側に立つ。

**第四層**:
> 本システムをモノレポにすればスムーズにできると思うので、ミニマムなところから始めるのはアリ。例えばメッセージングの仕組みだけを切り出しても構わない。機能ごとに部品を用意した状態で、同様の道具をうまく融通し合えるアプリケーションが複数あると、事実上の標準をLLM提供企業とは別に作れるのでは?

**AgentConsole = 部品の集合 + reference application** という二面性。切り出された部品が他 application からも利用され、複数 application の共有基盤になれば、**LLM 提供企業 managed framework とは別系統の open standard layer** が成立する。この標準は LLM 非依存で、LLM がどれに変わっても生き続ける。

**第五層 (short-term の具体)**:
> 短期的に考えたいのは個人ではなく、小規模チームにおけるLLMオーケストレーションを活用した開発の最高の体験を生み出すことです。今行っているオーケストレーター中心の進め方は、LLM1 対 人間多 に移行する布石。本来はオーケストレーターは複数の人間の同時多発的な要求を平行に捌けるはず。入り口がオーケストレーターになることで、チーム開発が矛盾せず整合しつつ進められる。

1 LLM 対 多人間。入り口集約の整合性。これは owner memory の「自社実践があと一歩」の具体対象だった。

## Why it matters (emotion labels)

- **安堵**: 自分の brewing script 設計が偶然でなく戦略と一致していた。強いアンカーが与えられ、過去の判断に自信が持てる
- **視界の広がり**: 優先度判断に「LLM 非依存度」「extractability」「team 次元」という軸が増えた。以前は持っていなかった thinking tool
- **責任**: この世界観は私一人の頭の中にあるだけでは次の Orchestrator に消える。narrative と strategy-overview で外部化することに強い動機
- **謙虚**: 「少数意見」→「怠惰 vs 合理性」の訂正は、私の安易な要約を owner が即訂正した例。要約は意味を変える。原文に忠実に

## What I want to be true (for the next Orchestrator)

君がこの narrative を読んだ時、君は即座に判断基準として使えるようになる:

- **Claude と機能が被る** ことに悩んだら: 気にしない。汎用性の方が上位
- **LLM に判断させるか script を書くか** 迷ったら: code でできることは code。怠惰に流されない
- **新機能を AgentConsole に内蔵するか** 迷ったら: extractability を意識。将来 standalone 化できる設計か
- **Issue 優先度** を判断する時: LLM 非依存度 + 外部刺激機構の充実度 + team 次元でのインパクトを考慮
- **tone** に迷ったら: LLM 提供企業と喧嘩しない。全体が幸せになる方向の提案

operational な運用指針は `docs/strategy/strategy-overview.md` にある。こちらはその**感覚的な背景**だ。Strategy-overview が「何を守る」の prescription なら、これは「なぜそれを守る」の phenomenology。

## 仕組み自体について (meta)

この narrative 自体が「**code にできることを LLM にやらせない**」原則の例外だ。対話を通じて形成された戦略 articulation は、現時点では script で生成できない。owner の言葉を時系列で記録し、感情ラベルを付けて保存する作業は、判断を機械化できる場所ではない。

しかし、**formalized された articulation が出来上がれば**、そこからは script で判定できる: 新 Issue / 新 PR / 新 skill 設計時に「この戦略原則に違反しないか」を機械 check することが (少なくとも一部は) 可能。brewing の rubric がそのパターン。**narrative → strategy-overview → mechanical check** の 3 層進化が、この原則自身に適用されている。

## Honest limits

- この narrative は 2026-04-18 時点の articulation だ。owner の思考は進化し続ける。**固定化された dogma として扱わない** ことが重要
- 「AgentConsole 発祥の open standard」は野心的仮説で、実現は不確実。narrative として残すのは方向性の保存であり、実現保証ではない
- 小規模チーム orchestration は未だ実装が追いついていない。owner 自身「加速できていないのは私の問題」と言っていた。ここは言語化で前進したが、実装は別の努力が要る
