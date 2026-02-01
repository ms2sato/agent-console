/**
 * POC 8: query()呼び出し時にClaude Codeプロセスが何個起動されるか確認
 * 並行実行中にpsコマンドでプロセス数を監視する
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { $ } from "bun";

async function countClaudeProcesses(): Promise<string> {
  const result = await $`ps aux | grep -i "claude" | grep -v grep | grep -v "process-check"`.text().catch(() => "");
  return result.trim();
}

async function runQuery(id: string, prompt: string): Promise<void> {
  console.log(`[${id}] started`);
  for await (const message of query({
    prompt,
    options: { allowedTools: [], maxTurns: 1 },
  })) {
    if (message.type === "system") {
      console.log(`[${id}] session_id=${message.session_id} pid=?`);
    }
    if (message.type === "result") {
      console.log(`[${id}] done`);
    }
  }
}

async function main() {
  console.log("=== Process Count Check ===\n");

  console.log("--- Before any query ---");
  console.log(await countClaudeProcesses() || "(no claude processes)");

  // 3つのクエリを並行で開始
  const promises = [
    runQuery("A", "What is 1+1? Reply with just the number."),
    runQuery("B", "What is 2+2? Reply with just the number."),
    runQuery("C", "What is 3+3? Reply with just the number."),
  ];

  // 1秒後にプロセスを確認
  await new Promise((r) => setTimeout(r, 1000));
  console.log("\n--- During concurrent queries (1s in) ---");
  const during = await countClaudeProcesses();
  console.log(during || "(no claude processes)");
  const processLines = during.split("\n").filter((l) => l.trim());
  console.log(`\n>>> Process count: ${processLines.length}`);

  await Promise.all(promises);

  console.log("\n--- After all queries ---");
  console.log(await countClaudeProcesses() || "(no claude processes)");
}

main().catch(console.error);
