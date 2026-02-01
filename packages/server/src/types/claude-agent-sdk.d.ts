/**
 * Minimal type declarations for @anthropic-ai/claude-agent-sdk.
 * The actual package is dynamically imported at runtime.
 * These declarations allow TypeScript to compile without the package installed.
 */
declare module '@anthropic-ai/claude-agent-sdk' {
  interface QueryOptions {
    cwd?: string;
    includePartialMessages?: boolean;
    abortController?: AbortController;
    permissionMode?: string;
    resume?: string;
    allowedTools?: string[];
    maxTurns?: number;
    model?: string;
    systemPrompt?: string;
    hooks?: Record<string, unknown>;
  }

  interface QueryInput {
    prompt: string;
    options?: QueryOptions;
  }

  function query(input: QueryInput): AsyncIterable<import('@agent-console/shared').SDKMessage>;
}
