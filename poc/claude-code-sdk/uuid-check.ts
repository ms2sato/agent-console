/**
 * POC 9: 全メッセージタイプにuuidが存在するか確認
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("=== UUID availability check ===\n");

  // stream_eventを含む全メッセージでuuidの有無を確認
  for await (const message of query({
    prompt: "What is 1+1? Just the number.",
    options: {
      allowedTools: [],
      maxTurns: 1,
      includePartialMessages: true,
    },
  })) {
    const hasUuid = "uuid" in message;
    const uuid = hasUuid ? (message as any).uuid : "N/A";
    console.log(`type=${message.type.padEnd(15)} uuid=${uuid}`);
  }
}

main().catch(console.error);
