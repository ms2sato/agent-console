/**
 * POC 10: resume時にSDKが過去メッセージを再送するか確認
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("=== Resume message replay check ===\n");

  // Turn 1
  let sessionId: string | undefined;
  console.log("--- Turn 1 ---");
  for await (const message of query({
    prompt: "Remember: SECRET=APPLE-99. Confirm receipt.",
    options: { allowedTools: [], maxTurns: 1 },
  })) {
    if (message.type === "system") sessionId = message.session_id;
    console.log(`  [${message.type}] uuid=${(message as any).uuid?.substring(0, 8)}...`);
  }

  console.log(`\nsessionId: ${sessionId}`);

  // Turn 2: resume - 全メッセージを詳細にログ
  console.log("\n--- Turn 2 (resume) - all yielded messages ---");
  let messageCount = 0;
  for await (const message of query({
    prompt: "What was the secret?",
    options: { allowedTools: [], maxTurns: 1, resume: sessionId },
  })) {
    messageCount++;
    const uuid = (message as any).uuid?.substring(0, 8) ?? "N/A";
    if (message.type === "assistant") {
      const text = (message as any).message?.content?.[0]?.text;
      console.log(`  [${messageCount}] type=${message.type} uuid=${uuid} text="${text?.substring(0, 100)}"`);
    } else {
      console.log(`  [${messageCount}] type=${message.type} uuid=${uuid}`);
    }
  }
  console.log(`\nTotal messages yielded on resume: ${messageCount}`);
  console.log("(If past messages were replayed, count would be > 3 [system + assistant + result])");
}

main().catch(console.error);
