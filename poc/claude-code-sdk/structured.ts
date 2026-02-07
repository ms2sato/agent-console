/**
 * POC 3: Tool use - ツール使用時のメッセージ構造を確認
 * cwdを指定して、ファイル読み取りを許可する
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("=== Claude Code SDK Tool Use POC ===\n");

  for await (const message of query({
    prompt: "Read the file package.json in the current directory and tell me the project name.",
    options: {
      allowedTools: ["Read"],
      maxTurns: 3,
      cwd: import.meta.dir, // This POC directory
      permissionMode: "acceptEdits",
    },
  })) {
    console.log(`\n=== [${message.type}] ===`);

    if (message.type === "assistant") {
      // Show content blocks
      const msg = (message as any).message;
      if (msg?.content) {
        for (const block of msg.content) {
          console.log(`  content block type: ${block.type}`);
          if (block.type === "text") {
            console.log(`  text: ${block.text.substring(0, 200)}`);
          } else if (block.type === "tool_use") {
            console.log(`  tool: ${block.name}`);
            console.log(`  input: ${JSON.stringify(block.input)}`);
          } else if (block.type === "thinking") {
            console.log(`  thinking: ${(block.thinking || "").substring(0, 100)}...`);
          }
        }
      }
    } else if (message.type === "result") {
      console.log(`  cost: $${(message as any).total_cost_usd}`);
      console.log(`  turns: ${(message as any).num_turns}`);
      console.log(`  result: ${JSON.stringify((message as any).result)?.substring(0, 200)}`);
    } else {
      console.log(`  ${JSON.stringify(message).substring(0, 200)}`);
    }
  }
}

main().catch(console.error);
