/**
 * POC 11: AskUserQuestion検出 - SDKがユーザー入力を求める時のメッセージ構造
 * allowedToolsにAskUserQuestionを含め、質問を誘発するプロンプトを送る
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  console.log("=== AskUserQuestion detection POC ===\n");

  for await (const message of query({
    prompt: "I need you to ask me what programming language I prefer before giving advice. Use the AskUserQuestion tool to ask me.",
    options: {
      allowedTools: ["AskUserQuestion"],
      maxTurns: 2,
      includePartialMessages: true,
    },
  })) {
    if (message.type === "stream_event") {
      const event = (message as any).event;
      // content_block_startでtool_useが来るか確認
      if (event?.type === "content_block_start") {
        console.log(`[stream_event] content_block_start:`, JSON.stringify(event.content_block, null, 2));
      }
      // deltaのinput_json_deltaも確認
      if (event?.type === "content_block_delta" && event?.delta?.type === "input_json_delta") {
        process.stdout.write(`[json_delta] ${event.delta.partial_json}`);
      }
    } else if (message.type === "assistant") {
      console.log(`\n[assistant] content blocks:`);
      const content = (message as any).message?.content ?? [];
      for (const block of content) {
        console.log(`  type=${block.type}`);
        if (block.type === "tool_use") {
          console.log(`  name=${block.name}`);
          console.log(`  input=${JSON.stringify(block.input, null, 2)}`);
        } else if (block.type === "text") {
          console.log(`  text=${block.text?.substring(0, 200)}`);
        }
      }
    } else if (message.type === "user") {
      // tool_resultがどう返るか
      const content = (message as any).message?.content ?? [];
      console.log(`\n[user] (tool_result):`);
      for (const block of content) {
        console.log(`  type=${block.type}`);
        if (block.type === "tool_result") {
          console.log(`  content=${JSON.stringify(block.content)?.substring(0, 300)}`);
        }
      }
    } else if (message.type === "result") {
      console.log(`\n[result] subtype=${message.subtype} is_error=${message.is_error}`);
    } else {
      console.log(`[${message.type}]`);
    }
  }
}

main().catch(console.error);
