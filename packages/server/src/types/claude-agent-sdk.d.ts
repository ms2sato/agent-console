/**
 * Minimal type declarations for @anthropic-ai/claude-agent-sdk.
 * The actual package is dynamically imported at runtime.
 * These declarations allow TypeScript to compile without the package installed.
 */
declare module '@anthropic-ai/claude-agent-sdk' {
  interface QueryOptions {
    prompt: string;
    options?: Record<string, unknown>;
  }

  function query(options: QueryOptions): AsyncIterable<Record<string, unknown>>;
}
