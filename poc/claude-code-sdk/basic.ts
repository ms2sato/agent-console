/**
 * POC 1: Basic query - SDK呼び出しとレスポンス構造の確認
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("=== Claude Code SDK Basic POC ===\n");

  for await (const message of query({
    prompt: "What is 2 + 2? Reply in one sentence.",
    options: {
      allowedTools: [], // No tools - pure conversation
      maxTurns: 1,
    },
  })) {
    console.log(`[type: ${message.type}]`);
    console.log(JSON.stringify(message, null, 2));
    console.log("---");
  }
}

main().catch(console.error);
