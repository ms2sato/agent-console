/**
 * POC 11c: AskUserQuestionをblockして、カスタムtool_resultを返せるか
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("=== AskUserQuestion block + custom result POC ===\n");

  for await (const message of query({
    prompt: "Ask me what programming language I prefer using the AskUserQuestion tool, then give me a tip for that language.",
    options: {
      allowedTools: ["AskUserQuestion"],
      maxTurns: 3,
      hooks: {
        PreToolUse: [
          {
            matcher: "AskUserQuestion",
            hooks: [
              async (input: any) => {
                console.log(">>> [HOOK] Blocking AskUserQuestion, returning custom result");
                // blockしてカスタムレスポンスを返す
                return {
                  decision: "block",
                  reason: 'User answered: "TypeScript"',
                };
              },
            ],
          },
        ],
      },
    },
  })) {
    if (message.type === "assistant") {
      const content = (message as any).message?.content ?? [];
      for (const block of content) {
        if (block.type === "text") {
          console.log(`[assistant text] ${block.text?.substring(0, 400)}`);
        } else if (block.type === "tool_use") {
          console.log(`[assistant tool_use] ${block.name}`);
        }
      }
    } else if (message.type === "user") {
      const content = (message as any).message?.content ?? [];
      for (const block of content) {
        console.log(`[user] type=${block.type} content=${JSON.stringify(block.content)?.substring(0, 300)}`);
      }
    } else if (message.type === "result") {
      console.log(`\n[result] ${message.result?.substring(0, 400)}`);
    }
  }
}

main().catch(console.error);
