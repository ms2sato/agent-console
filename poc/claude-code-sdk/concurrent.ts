/**
 * POC 6: Concurrent - 複数のquery()を同時実行できるか確認
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function runQuery(id: string, prompt: string): Promise<void> {
  const start = Date.now();
  console.log(`[${id}] started`);

  for await (const message of query({
    prompt,
    options: {
      allowedTools: [],
      maxTurns: 1,
    },
  })) {
    if (message.type === "result") {
      const elapsed = Date.now() - start;
      console.log(
        `[${id}] completed in ${elapsed}ms | cost=$${message.total_cost_usd} | result=${message.result?.substring(0, 80)}`
      );
    }
  }
}

async function main() {
  console.log("=== Claude Code SDK Concurrent POC ===\n");

  const start = Date.now();

  // 3つのクエリを並行実行
  await Promise.all([
    runQuery("A", "What is 10 * 10? Reply with just the number."),
    runQuery("B", "What is the capital of Japan? Reply with just the city name."),
    runQuery("C", "What color is the sky? Reply with just the color."),
  ]);

  const total = Date.now() - start;
  console.log(`\n>>> All completed in ${total}ms`);
  console.log(
    total < 15000
      ? ">>> Likely ran in parallel (total < sum of individual times)"
      : ">>> May have run sequentially"
  );
}

main().catch(console.error);
