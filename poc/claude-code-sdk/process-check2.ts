/**
 * POC 8b: query()ごとにClaude Codeの子プロセスが何個起動されるか
 * クエリ開始前後のプロセス差分で確認する
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { $ } from "bun";

async function getClaudePids(): Promise<Set<number>> {
  const raw = await $`pgrep -f "claude"`.text().catch(() => "");
  const pids = new Set<number>();
  for (const line of raw.trim().split("\n")) {
    const pid = parseInt(line.trim());
    if (!isNaN(pid)) pids.add(pid);
  }
  return pids;
}

async function main() {
  console.log("=== Process Diff Check ===\n");

  const before = await getClaudePids();
  console.log(`Before: ${before.size} claude-related pids`);

  // 3つのクエリを開始（応答を待たずにプロセス数を確認したい）
  const promises = [
    query({ prompt: "What is 1+1? Just the number.", options: { allowedTools: [], maxTurns: 1 } }),
    query({ prompt: "What is 2+2? Just the number.", options: { allowedTools: [], maxTurns: 1 } }),
    query({ prompt: "What is 3+3? Just the number.", options: { allowedTools: [], maxTurns: 1 } }),
  ];

  // 少し待ってからプロセスを確認
  await new Promise((r) => setTimeout(r, 1500));
  const during = await getClaudePids();
  console.log(`During: ${during.size} claude-related pids`);

  const newPids = [...during].filter((p) => !before.has(p));
  console.log(`New pids spawned: ${newPids.length}`);
  console.log(`New pids: ${newPids.join(", ")}`);

  // クエリを消費して完了させる
  for (const q of promises) {
    for await (const msg of q) {
      // drain
    }
  }

  await new Promise((r) => setTimeout(r, 500));
  const after = await getClaudePids();
  console.log(`\nAfter: ${after.size} claude-related pids`);
  const remaining = [...after].filter((p) => !before.has(p));
  console.log(`Remaining new pids: ${remaining.length}`);
}

main().catch(console.error);
