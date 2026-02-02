/**
 * POC 12b: エラー詳細とCLIオプション確認
 */
import { $ } from "bun";

async function main() {
  // CLIのresumeオプションを確認
  console.log("--- claude --help (resume related) ---");
  const help = await $`claude --help 2>&1`.text().catch(e => e.message);
  const lines = help.split("\n").filter((l: string) =>
    l.toLowerCase().includes("resume") || l.toLowerCase().includes("session") || l.toLowerCase().includes("continue")
  );
  console.log(lines.join("\n") || "(no resume/session/continue options found)");

  // session_idを直接指定してresume
  const sessionId = "e10b7eb1-5a99-44be-9eb8-cd9d7b94fad6";

  console.log("\n--- Try: claude --resume <id> -p ---");
  const r1 = await $`claude --resume ${sessionId} -p "What was the secret code?" 2>&1`.text().catch(e => e.stderr || e.message);
  console.log(r1.substring(0, 500));

  console.log("\n--- Try: claude -c -p (continue latest) ---");
  const r2 = await $`claude -c -p "What was the secret code?" 2>&1`.text().catch(e => e.stderr || e.message);
  console.log(r2.substring(0, 500));
}

main().catch(console.error);
