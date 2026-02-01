/**
 * POC 11b: AskUserQuestion をhookで介入し、ユーザー回答を注入できるか確認
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("=== AskUserQuestion hook interception POC ===\n");

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
                console.log("\n>>> [HOOK] PreToolUse AskUserQuestion intercepted!");
                console.log(">>> [HOOK] tool_input:", JSON.stringify(input.tool_input, null, 2));
                // ここで実際にはWebSocket経由でフロントエンドに質問を送り、
                // ユーザーの回答を待つことになる
                // 今はシミュレートして "TypeScript" と回答する
                return {
                  decision: "modify",
                  tool_input: {
                    ...input.tool_input,
                    // hookでinputを変更してユーザー回答を注入できるか？
                    answers: { "0": "TypeScript" }
                  }
                };
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "AskUserQuestion",
            hooks: [
              async (input: any) => {
                console.log("\n>>> [HOOK] PostToolUse AskUserQuestion");
                console.log(">>> [HOOK] tool_result:", JSON.stringify(input.tool_result)?.substring(0, 300));
                return { decision: "continue" };
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
          console.log(`\n[assistant text] ${block.text?.substring(0, 300)}`);
        } else if (block.type === "tool_use") {
          console.log(`\n[assistant tool_use] ${block.name}: ${JSON.stringify(block.input)?.substring(0, 200)}`);
        }
      }
    } else if (message.type === "user") {
      const content = (message as any).message?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_result") {
          console.log(`\n[user tool_result] ${JSON.stringify(block.content)?.substring(0, 300)}`);
        }
      }
    } else if (message.type === "result") {
      console.log(`\n[result] ${message.result?.substring(0, 300)}`);
    }
  }
}

main().catch(console.error);
