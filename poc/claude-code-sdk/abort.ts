/**
 * POC 4: Abort - 実行中のクエリをキャンセルできるか確認
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("=== Claude Code SDK Abort POC ===\n");

  const abortController = new AbortController();

  // 2秒後にキャンセル
  setTimeout(() => {
    console.log("\n>>> Aborting after 2 seconds...");
    abortController.abort();
  }, 2000);

  try {
    for await (const message of query({
      prompt:
        "Write a very long essay about the history of computing, at least 2000 words.",
      options: {
        allowedTools: [],
        maxTurns: 1,
        includePartialMessages: true,
        abortController,
      },
    })) {
      if (message.type === "stream_event") {
        const event = (message as any).event;
        if (
          event?.type === "content_block_delta" &&
          event?.delta?.type === "text_delta"
        ) {
          process.stdout.write(".");
        }
      } else if (message.type === "result") {
        console.log(`\n[RESULT] subtype=${message.subtype}`);
        console.log(
          JSON.stringify(
            { subtype: message.subtype, is_error: message.is_error, result: message.result },
            null,
            2
          )
        );
      } else {
        console.log(`[${message.type}]`);
      }
    }
  } catch (err: any) {
    console.log(`\n[CAUGHT ERROR] name=${err.name} message=${err.message}`);
  }

  console.log("\n>>> Script completed (did not hang)");
}

main().catch(console.error);
