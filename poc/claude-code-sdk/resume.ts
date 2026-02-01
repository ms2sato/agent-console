/**
 * POC 5: Resume - session_idを使って会話を継続できるか確認
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("=== Claude Code SDK Resume POC ===\n");

  // --- Turn 1: 初回クエリ ---
  console.log("--- Turn 1: Initial query ---");
  let sessionId: string | undefined;

  for await (const message of query({
    prompt: "Remember this secret code: PINEAPPLE-42. Just confirm you received it.",
    options: {
      allowedTools: [],
      maxTurns: 1,
    },
  })) {
    if (message.type === "system") {
      sessionId = message.session_id;
      console.log(`session_id: ${sessionId}`);
    } else if (message.type === "assistant") {
      const text = (message as any).message?.content?.[0]?.text;
      console.log(`assistant: ${text?.substring(0, 200)}`);
    } else if (message.type === "result") {
      console.log(`result: ${message.result}`);
    }
  }

  if (!sessionId) {
    console.error("No session_id obtained!");
    return;
  }

  // --- Turn 2: resumeで会話を継続 ---
  console.log("\n--- Turn 2: Resume with session_id ---");

  for await (const message of query({
    prompt: "What was the secret code I told you earlier?",
    options: {
      allowedTools: [],
      maxTurns: 1,
      resume: sessionId,
    },
  })) {
    if (message.type === "assistant") {
      const text = (message as any).message?.content?.[0]?.text;
      console.log(`assistant: ${text?.substring(0, 300)}`);
    } else if (message.type === "result") {
      console.log(`result: ${message.result}`);
      console.log(`turns total: ${message.num_turns}`);
    }
  }

  console.log("\n>>> Resume test completed");
}

main().catch(console.error);
