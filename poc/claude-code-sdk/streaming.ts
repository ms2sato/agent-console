/**
 * POC 2: Streaming - includePartialMessagesでストリーミングイベントの構造を確認
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("=== Claude Code SDK Streaming POC ===\n");

  for await (const message of query({
    prompt: "Explain what a WebSocket is in 2-3 sentences.",
    options: {
      allowedTools: [],
      maxTurns: 1,
      includePartialMessages: true,
    },
  })) {
    if (message.type === "assistant") {
      console.log("\n[COMPLETE assistant message]");
      console.log(JSON.stringify(message, null, 2));
    } else if (message.type === "result") {
      console.log("\n[RESULT]");
      console.log(
        JSON.stringify(
          {
            type: message.type,
            subtype: message.subtype,
            duration_ms: message.duration_ms,
            total_cost_usd: message.total_cost_usd,
            num_turns: message.num_turns,
            usage: message.usage,
          },
          null,
          2
        )
      );
    } else {
      // stream_event or other types
      const summary = {
        type: message.type,
        ...(("event" in message && message.event) ? { eventType: (message as any).event?.type } : {}),
      };
      console.log(`[${summary.type}] eventType=${summary.eventType ?? "N/A"}`);
    }
  }
}

main().catch(console.error);
