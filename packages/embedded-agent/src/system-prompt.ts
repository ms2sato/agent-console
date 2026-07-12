/**
 * System-prompt assembly for the embedded-agent loop.
 *
 * The prompt is assembled once per activation, in a spec-mandated order:
 *   (1) context preamble  ->  (2) AGENTS.md repository conventions  ->
 *   (3) the operator-configured definition system prompt (last, so it wins on
 *   conflict). Sections are joined with a blank line.
 */

import { join } from 'node:path';
import { truncateToBytes } from './truncate.js';

const AGENTS_MD_MAX_BYTES = 32768;
const AGENTS_MD_BLOCK_START = '--- Repository conventions (AGENTS.md) ---';
const AGENTS_MD_BLOCK_END = '--- End of repository conventions ---';

export interface SystemPromptContext {
  sessionId: string;
  workerId: string;
  cwd: string;
  repositoryId?: string;
}

export interface AssembleSystemPromptParams {
  context: SystemPromptContext;
  agentsMd: string | null;
  definitionSystemPrompt?: string;
}

function buildPreamble(context: SystemPromptContext): string {
  const lines = [
    'You are an embedded agent running inside agent-console.',
    `Session ID: ${context.sessionId}`,
    `Worker ID: ${context.workerId}`,
    `Working directory: ${context.cwd}`,
  ];
  if (context.repositoryId !== undefined) {
    lines.push(`Repository ID: ${context.repositoryId}`);
  }
  lines.push(
    'When an MCP tool accepts a sessionId or fromSessionId argument, use the Session ID above.',
  );
  return lines.join('\n');
}

export function assembleSystemPrompt(params: AssembleSystemPromptParams): string {
  const sections: string[] = [buildPreamble(params.context)];

  if (params.agentsMd !== null) {
    sections.push(`${AGENTS_MD_BLOCK_START}\n${params.agentsMd}\n${AGENTS_MD_BLOCK_END}`);
  }

  if (params.definitionSystemPrompt !== undefined && params.definitionSystemPrompt.length > 0) {
    sections.push(params.definitionSystemPrompt);
  }

  return sections.join('\n\n');
}

/**
 * Read `<cwd>/AGENTS.md` (that single file, cwd root only). Missing or
 * unreadable returns null (logged, never fatal). Content larger than 32 KiB is
 * truncated at a UTF-8-safe boundary with an explicit truncation-notice line
 * appended so it lands inside the delimited block.
 */
export async function readAgentsMd(cwd: string): Promise<string | null> {
  const path = join(cwd, 'AGENTS.md');
  try {
    const raw = await Bun.file(path).text();
    const { text, truncated } = truncateToBytes(raw, AGENTS_MD_MAX_BYTES);
    if (truncated) {
      return `${text}\n[AGENTS.md truncated at ${AGENTS_MD_MAX_BYTES} bytes]`;
    }
    return text;
  } catch (err) {
    console.error(
      `Failed to read AGENTS.md at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
