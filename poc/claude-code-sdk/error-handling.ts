/**
 * POC 7: Error handling - 不正な入力やエラー時のレスポンス構造を確認
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function testCase(
  name: string,
  fn: () => Promise<void>
): Promise<void> {
  console.log(`\n--- ${name} ---`);
  try {
    await fn();
  } catch (err: any) {
    console.log(`[CAUGHT] ${err.constructor.name}: ${err.message}`);
    if (err.cause) console.log(`  cause: ${err.cause}`);
  }
}

async function main() {
  console.log("=== Claude Code SDK Error Handling POC ===");

  // Test 1: Empty prompt
  await testCase("Empty prompt", async () => {
    for await (const message of query({
      prompt: "",
      options: { allowedTools: [], maxTurns: 1 },
    })) {
      console.log(`[${message.type}] ${message.type === "result" ? `subtype=${message.subtype} is_error=${message.is_error}` : ""}`);
      if (message.type === "result") {
        console.log(`  result: ${JSON.stringify(message.result)?.substring(0, 200)}`);
      }
    }
  });

  // Test 2: Invalid resume session
  await testCase("Invalid resume session_id", async () => {
    for await (const message of query({
      prompt: "Hello",
      options: {
        allowedTools: [],
        maxTurns: 1,
        resume: "non-existent-session-id-12345",
      },
    })) {
      console.log(`[${message.type}] ${message.type === "result" ? `subtype=${message.subtype} is_error=${message.is_error}` : ""}`);
      if (message.type === "result" && message.is_error) {
        console.log(`  error result: ${JSON.stringify(message.result)?.substring(0, 200)}`);
      }
    }
  });

  // Test 3: maxTurns = 0
  await testCase("maxTurns = 0", async () => {
    for await (const message of query({
      prompt: "Hello",
      options: { allowedTools: [], maxTurns: 0 },
    })) {
      console.log(`[${message.type}] ${message.type === "result" ? `subtype=${message.subtype} is_error=${message.is_error}` : ""}`);
    }
  });

  console.log("\n>>> Error handling tests completed");
}

main().catch(console.error);
