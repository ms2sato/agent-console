/**
 * POC 12: SDKのsession_idをCLIの --resume で引き継げるか確認
 * SDKで会話を開始 → CLIで同じsession_idを指定して継続できるか
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { $ } from "bun";

async function main() {
  console.log("=== SDK→CLI session sharing POC ===\n");

  // Step 1: SDKで会話を開始し、session_idを取得
  let sessionId: string | undefined;
  console.log("--- Step 1: SDK query ---");
  for await (const message of query({
    prompt: "Remember this code: MANGO-77. Confirm receipt.",
    options: { allowedTools: [], maxTurns: 1 },
  })) {
    if (message.type === "system") {
      sessionId = (message as any).session_id;
      console.log(`session_id: ${sessionId}`);
    }
    if (message.type === "result") {
      console.log(`SDK result: ${(message as any).result}`);
    }
  }

  if (!sessionId) {
    console.error("No session_id!");
    return;
  }

  // Step 2: CLIで同じsession_idを使って会話を継続できるか
  console.log("\n--- Step 2: CLI with --resume ---");
  try {
    const result = await $`claude --resume ${sessionId} -p "What was the secret code I told you?" --no-input 2>&1`.text();
    console.log(`CLI output: ${result.substring(0, 300)}`);
  } catch (err: any) {
    console.log(`CLI error: ${err.message?.substring(0, 300)}`);
    // --resumeが無いかもしれないので、-cも試す
    console.log("\n--- Step 2b: CLI with -c and session_id ---");
    try {
      const result2 = await $`claude -c --session-id ${sessionId} -p "What was the secret code I told you?" --no-input 2>&1`.text();
      console.log(`CLI output: ${result2.substring(0, 300)}`);
    } catch (err2: any) {
      console.log(`CLI error: ${err2.message?.substring(0, 300)}`);
    }
  }
}

main().catch(console.error);
