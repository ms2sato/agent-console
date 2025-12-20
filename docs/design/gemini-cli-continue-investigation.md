# Gemini CLI Continue Investigation

Investigation of implementing the "Continue" feature for Gemini CLI in agent-console.

## Executive Summary

**Gemini CLI supports session continuation via the `--resume` flag**, making it compatible with agent-console's Continue feature architecture.

| Feature | Claude Code | Gemini CLI |
|---------|-------------|------------|
| Continue Command | `claude -c` | `gemini --resume` |
| Session Management | Implicit (latest) | Project-specific, auto-saved |
| Minimum Version | N/A | v0.20.0+ |

## Gemini CLI Session Management

### Resume Methods

Gemini CLI provides three ways to resume sessions:

| Method | Command | Description |
|--------|---------|-------------|
| Latest session | `gemini --resume` | Loads most recent session |
| By index | `gemini --resume 5` | Loads session by number |
| By UUID | `gemini --resume <UUID>` | Loads specific session |

### Automatic Session Saving

Since v0.20.0, Gemini CLI automatically saves all interactions:

- **Storage location**: `~/.gemini/tmp/<project_hash>/chats/`
- **Saved data**: Prompts, responses, tool executions, token statistics
- **Scope**: Project-specific (based on working directory)

### Configuration Options

```json
{
  "general": {
    "sessionRetention": {
      "enabled": true,
      "maxAge": "30d",
      "maxCount": 50
    }
  },
  "model": {
    "maxSessionTurns": 100
  }
}
```

## Implementation Plan

### Phase 1: Basic Agent Definition

Create a built-in Gemini CLI agent definition:

```typescript
// packages/server/src/services/agents/gemini-cli.ts
export const GEMINI_CLI_AGENT_ID = 'gemini-cli-builtin';

const GEMINI_ASKING_PATTERNS: string[] = [
  // Tool execution confirmation
  'Continue\\?.*\\[Y/n\\]',
  '\\[Y/n\\]',
  // File operation confirmation
  'Proceed\\?',
  // Prompt waiting
  '>\\s*$',
];

const geminiCliAgentBase = {
  id: GEMINI_CLI_AGENT_ID,
  name: 'Gemini CLI',
  commandTemplate: 'gemini {{prompt}}',
  continueTemplate: 'gemini --resume',
  headlessTemplate: 'gemini -p {{prompt}}',  // To be verified
  description: 'Google Gemini CLI - AI coding assistant',
  isBuiltIn: true,
  registeredAt: new Date(0).toISOString(),
  activityPatterns: {
    askingPatterns: GEMINI_ASKING_PATTERNS,
  },
};

export const geminiCliAgent: AgentDefinition = {
  ...geminiCliAgentBase,
  capabilities: computeCapabilities(geminiCliAgentBase),
};
```

### Phase 2: Session ID Integration (Optional)

For more precise session continuation, store Gemini session UUIDs in worker metadata:

```typescript
interface AgentWorkerMetadata {
  geminiSessionId?: string;  // Gemini CLI session UUID
}

// On Continue, use: gemini --resume <UUID>
```

**Note**: This may not be necessary for initial implementation since `gemini --resume` restores the latest project-specific session.

## Technical Considerations

### Challenge 1: Session Identification

Unlike Claude Code's simple `claude -c`, Gemini manages multiple sessions per project.

**Mitigation**: Since Gemini sessions are project-specific (based on working directory), using `gemini --resume` within the same worktree should correctly restore the relevant session.

### Challenge 2: Activity Detection Patterns

Gemini CLI output patterns differ from Claude Code. The `askingPatterns` need to be tuned based on actual observation.

**Action Required**: Run Gemini CLI interactively and document output patterns for:
- Tool execution confirmations
- File write confirmations
- User question prompts
- Idle/waiting states

### Challenge 3: Node.js Dependency

Gemini CLI requires Node.js 20+ and is typically invoked via:
```bash
npx @google/gemini-cli
# or
gemini  # if installed globally
```

**Considerations**:
- PTY compatibility with `npx` invocation
- Bun environment compatibility
- Global installation vs npx

### Challenge 4: OAuth Authentication

First-time authentication requires browser interaction:
```bash
gemini  # Opens browser for Google OAuth
```

**Considerations**:
- Initial setup requires user interaction outside agent-console
- API key authentication as alternative (limited free tier)
- Document setup requirements clearly

## Verification Checklist

Before implementation, verify:

- [ ] `gemini --resume` works correctly within a worktree
- [ ] Observe actual Gemini CLI output patterns for activity detection
- [ ] Confirm PTY behavior with `npx @google/gemini-cli`
- [ ] Test OAuth flow in terminal environment
- [ ] Verify `gemini -p` (or equivalent) for headless mode

## Gemini CLI vs Claude Code Comparison

| Aspect | Gemini CLI | Claude Code |
|--------|------------|-------------|
| **License** | Apache 2.0 (Open Source) | Proprietary |
| **PTY Support** | node-pty (full support) | Supported |
| **Free Tier** | 60 req/min, 1,000 req/day | Limited |
| **Context Window** | 1M tokens (Gemini 2.5 Pro) | 200k tokens |
| **Built-in Tools** | File, Shell, Web Search | File, Shell, Editor |
| **MCP Support** | Yes | Yes |
| **Session Persistence** | Auto-save to local files | Built-in |

## Gemini CLI Interactive Features

### In-Session Commands

| Command | Description |
|---------|-------------|
| `/resume` | Opens Session Browser for interactive selection |
| `/chat save <tag>` | Saves conversation checkpoint |
| `/chat resume <tag>` | Resumes from checkpoint |
| `/chat list` | Lists available checkpoints |
| `/clear` | Clears terminal and conversation context |
| `/memory` | View/manage memory |
| `/tools` | List available tools |
| `/mcp` | MCP server management |

### Gemini Interactions API (Beta)

For advanced use cases, the Interactions API provides server-side state management:

- `previous_interaction_id` parameter for conversation chaining
- Implicit caching for performance optimization
- 55-day data retention (paid accounts)

**Note**: This is currently in beta and may not be necessary for agent-console integration.

## References

- [Session Management | Gemini CLI](https://geminicli.com/docs/cli/session-management/)
- [Pick up exactly where you left off - Google Developers Blog](https://developers.googleblog.com/pick-up-exactly-where-you-left-off-with-session-management-in-gemini-cli/)
- [GitHub - google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
- [How to resume the conversation? - GitHub Discussion](https://github.com/google-gemini/gemini-cli/discussions/1538)
- [Interactions API | Gemini API](https://ai.google.dev/gemini-api/docs/interactions)

## Related Documents

- [Agent Continuation Strategy](./agent-continuation-strategy.md) - Compaction handling strategy
- [Custom Agent Design](./custom-agent-design.md) - Agent definition structure
- [Activity Detector](../activity-detector.md) - Activity detection patterns
