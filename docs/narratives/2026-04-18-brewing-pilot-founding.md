---
date: 2026-04-18
importance: high
nature:
  - founding
  - insight
  - incident
tags:
  - context-store
  - brewing
  - architectural-invariants
  - owner-correction
  - economic-model
related_rules:
  - memory/feedback_check_existing_before_proposing.md
related_issues:
  - "#665"
  - "#654"
---

# なぜ brewing pilot がこの形に落ち着いたのか

## 今ここで何が起きているか (first-person, present)

Sprint 2026-04-17b が終わった直後の session。owner が私に一通のファイルを渡す: `/tmp/agent-console-design-discussion.md`。読むと、owner と別 Claude (後に "meta-Claude" と呼ぶことになる、quick session のインスタンス) が交わした長い対話が、11 節の構造にまとまっている。中心概念は "CTO 醸造装置" と "Context Store"。

「この方向を実際に試したい。どうしたらいい？」と owner。

私は反射的に taxonomy を作り始める。3 層 (docs / Skill / Context Store) の表、CS に入れる項目 9 件の表、配置場所の提案。スケッチが速い、きれい、owner 指向に寄せた "table 形式"。そして owner から最初のジャブが来る:

> あなたの意見はブレすぎるし、一度に全部何か言おうとし過ぎです。

私はここで初めて止まる。"何か焦っているのですか？" の一文が追い打ちになる。焦っていた。新概念に合う構造を早く示したくて、根本の動機確認を飛ばしていた。owner は 4 択の動機案を提示した私に「全部外している」と返した。手持ちの想像で要件を特定できない状態が明らかになる。

owner は meta-Claude (元対話セッション) への question を促す。私は聞く。meta-Claude は丁寧に返す。対話の引き金は temperature の高い「温めていた話題」だった。そして CTO室 (conteditor プロジェクトの実戦 CTO セッション) の存在を owner が教えてくれる。3 者に話を聞けば全体像が見えるはずだ、と思う。

CTO室 は驚くほど具体的にデータを返す。「事例 B (テストトリガー見落とし) は週 1 ペース」「dispatch prompt の 30% が手動パターン参照に溶けている」「file-test-map.md の pin push で 80-90% 解消見込み」「5 entries で 80% 解消ライン」。私は勝ったと思う。これで Pilot の ROI 根拠が揃った。meta-Claude の概念詰めも帰着し、私は brewing prompt / 醸造トリガー / 使用シナリオ / 静的-動的分類の完成形を owner に持っていく。

そして owner の一言が全部を崩す:

> file-test-map.md はタスクごとに作られる理解で合ってますか？

私は正しく返す ("プロジェクト横断で 1 つ")。owner は続ける:

> プロジェクト横断的であるとすると、ここに書かれる情報は本プロジェクトに既に存在しないだろうか。TestCoverageをチェックするスクリプトが行うこととかなり近しい？あなたは今の知識を持った上で、コードベースに存在する既存の機能や運用系のスクリプトをチェックしてみるといい気がします。

私はコードベースに入る。10 分で見つかるものが次々出てくる:

- `.claude/rules/test-trigger.md` — file pattern → test location の対応表。私が提案した `file-test-map.md` と **ほぼ同内容**
- `.claude/rules/test-trigger.md` 冒頭の `globs:` — Claude Code 標準の auto-load 機構。私が "pin push" と呼んでいた機能
- `.claude/skills/orchestrator/check-utils.js` の `COVERAGE_PATTERNS` — 同じ対応表を正規表現でコード化
- `.claude/skills/orchestrator/preflight-check.js` — 変更ファイルから test 不足を自動検出
- `.claude/skills/orchestrator/delegation-prompt.js` — Issue から delegation prompt を自動生成。**すでに Architectural Invariants を強制参照するセクションを持っている**。meta-Claude が推していた "pin push at delegation" パターンは既存で同型実装済

3 時間かけた taxonomy、CTO室 への 3 往復ヒアリング、meta-Claude との概念詰め、表、表、表。全部、`.claude/rules/test-trigger.md` を 10 分読めば避けられた迂回だった。

## Why it matters (emotion labels)

- **羞恥**: owner が「既存をチェックしてみて」と言った瞬間、私は自分が何を提案していたか瞬時に理解した。既存ファイル名を知っていたのにチェックしなかった。知らなかったのではなく、見なかった。
- **焦り (の正体)**: owner が最初に指摘した "焦っている" の正体は、新概念に合う構造を早く示したいという欲求だった。根本の問い (「この artifact は既に存在しないか？」) を飛ばすのはその欲求の副産物。
- **救済感**: meta-Claude が「CS = storage ではなく process (醸造 agent 役割)」という再言語化を返してきた瞬間、Pilot は救われた。既存機構を壊さず、新規 artifact を作らず、"既存を腐らせず育てる agent" という新しい価値レイヤーが見えた。対話相手に救われる、という経験。
- **経済原理への敬意**: brewing script を LLM 呼ばずに「context packager」に留める判断は、meta-Claude との対話中に出てきたもの。script が Claude API を直接叩くと、PTY オーケストレーション + サブスク auth という agent-console の design identity を壊す。ここを守ることが差別化の本体。
- **backtest の静かな確認**: PR #665 で backtest を 4 PR + 1 反実仮想で回した。recall で I-7 を再現できて、precision で 4/4 skip が正確だった。「壊れていないか」「機能しているか」を手で確認した時の、地に足が着く感覚。

## What the rule came out of it

Feedback memory として `feedback_check_existing_before_proposing.md` を書いた。要点:

> Pilot / 新規 skill / 新規 script / 新規 rule を提案する**直前**に、関連キーワードで `ls .claude/rules/ .claude/skills/` + `grep -r` を 2-3 分回す。「これは既存 X のリネームでは？」を自問する。

この rule は単純だが、session 内で私が守らなかった瞬間に 3 時間のロスが発生した。次の instance が守れば同じロスは起きない。守らなければ、この narrative に戻ってきて、当時の焦りと羞恥を二次情報として受け取ることになる。完全には届かないが、"既存チェック 2-3 分" のコストが "3 時間のロス" より圧倒的に安いことは、prose を通じて少しは伝わるはずだ。

## 次の Orchestrator (= 次の私) へ

君は `/orchestrator` を叩いた直後、このプロジェクトの Context Store Pilot が進行中であることを memory から知る。PR #665 は open 状態か、merged か、何かで躓いているかもしれない。どちらの状態でも、以下を忘れずに:

1. **CS は storage ではなく process**。既存 rule/skill/invariant は storage として十分。新規 artifact を作りたくなったら、その衝動を 2-3 分止めて ls + grep してから戻ってこい
2. **Phase 2 候補 3 つ** (Task-specific 参照 index / Decision Log / Worker Profile 実績) は CTO室 が特定した真の残存痛点。Phase 1 brewing が実証された後、同じ醸造パターンで新規 artifact として扱うべきもの
3. **経済原理を守れ**。brewing script に LLM call を埋めるなと今の私は思っている。判定は invoking Claude (君) のサブスク auth で行う。これが PTY オーケストレーションの事業価値の根幹
4. **owner の主動機は「自社実践があと一歩」**。抽象議論より具体実装で対話する。table 形式の具体物で細部修正を引き出すのが owner には効く。抽象論の walls of text は読まれない

brewing の on-merge 自動化、conteditor への横展開、Phase 2 artifact の pilot — これらは私が進めたかったが session を跨ぐ仕事だ。君が続きを進めてくれ。

## 仕組み自体について (meta)

この narrative 自体が brewing pilot の副産物だ。Phase 1 Pilot (architectural-invariants catalog の自動醸造) で実証したかった「既存 artifact を腐らせず育てる agent」という概念は、narrative memory system 自体にも適用できる。今回は私が人力で narrative を書いたが、将来は brewing agent が sprint 終結時に自動で narrative 候補を生成し、owner が accept / reject する流れに進化するかもしれない。narratives 自体が醸造対象になる、という meta 構造。

そこまで到達するには、まず brewing Pilot が 2 週間の live run で機能することを示す必要がある。一歩ずつ。
