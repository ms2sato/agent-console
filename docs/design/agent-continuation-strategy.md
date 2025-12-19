# Agent Continuation Strategy Design Document

## Background

AI coding agents like Claude Code have a context window limit. When the context approaches capacity (~95%), **Auto Compaction** occurs automatically, summarizing the conversation and discarding detailed context. This causes several problems:

- Loss of detailed context during ongoing work
- Progress on complex tasks becomes unclear
- Repetition of the same investigation and analysis
- Users need technical knowledge (Claude Code Hooks) to mitigate these issues

### Goal

Enable agent-console to automatically preserve and restore work context across Compaction events, **without requiring users to configure Claude Code Hooks or have specialized knowledge**.

## Current State: Claude Code's Built-in Mechanisms

### Auto Compaction

- Triggers when context window reaches ~95% capacity
- Generates a summary of past interactions and decisions
- Replaces old messages with the summary
- Users can manually trigger with `/compact` command

### Mitigation Options (User-side)

| Method | Description | Limitation |
|--------|-------------|------------|
| Extended context (`/model sonnet[1m]`) | Use 1M token context | Delays but doesn't prevent Compaction |
| Manual `/compact` | Controlled Compaction at logical breakpoints | Requires user discipline |
| `PreCompact` Hook | Run script before Compaction | Requires technical setup |
| Checkpointing (`/rewind`) | Restore to previous state | Limited rollback scope |

## Proposed Solution

agent-console handles Compaction detection and context preservation at the server level, making this transparent to users.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           agent-console Server                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────┐   │
│  │ PTY Output   │───►│ Compaction   │───►│ Context Extraction       │   │
│  │ Buffer       │    │ Detector     │    │ & Storage                │   │
│  └──────────────┘    └──────────────┘    └──────────────────────────┘   │
│         │                                           │                   │
│         │                                           ▼                   │
│         │                                ┌──────────────────────────┐   │
│         │                                │ LLM Summarization        │   │
│         │                                │ (haiku, low cost)        │   │
│         │                                └──────────────────────────┘   │
│         │                                           │                   │
│         ▼                                           ▼                   │
│  ┌──────────────┐                        ┌──────────────────────────┐   │
│  │ Text Log     │◄──────────────────────►│ Context Database         │   │
│  │ Export       │                        │ (per session)            │   │
│  └──────────────┘                        └──────────────────────────┘   │
│                                                     │                   │
│                                                     ▼                   │
│                                          ┌──────────────────────────┐   │
│                                          │ Context Injection        │   │
│                                          │ (on session resume)      │   │
│                                          └──────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. Compaction Detector

Monitors PTY output for Compaction-related messages:

```typescript
// Possible detection patterns (to be confirmed)
const COMPACTION_PATTERNS = [
  /Auto-compacting conversation/i,
  /Compacting context/i,
  // Add more patterns as discovered
];

class CompactionDetector {
  detect(output: string): boolean {
    return COMPACTION_PATTERNS.some(pattern => pattern.test(output));
  }
}
```

#### 2. Context Extraction & Storage

When Compaction is detected (or periodically), extract important information:

- Active/completed TODO items
- Recent decisions and reasoning
- Files being modified
- Current work focus

#### 3. LLM Summarization

Use a lightweight model (haiku) to generate structured summaries:

```typescript
interface SessionContext {
  sessionId: string;
  workerId: string;
  timestamp: Date;
  summary: {
    currentTask: string;
    completedSteps: string[];
    pendingSteps: string[];
    keyDecisions: string[];
    relevantFiles: string[];
  };
}

async function summarizeContext(log: string): Promise<SessionContext['summary']> {
  const response = await llm.generate({
    model: 'haiku',
    prompt: `Summarize this agent session for continuation.
Extract:
- Current task being worked on
- Steps already completed
- Remaining steps
- Key decisions made
- Files being modified

Session log:
${log}`
  });
  return parseResponse(response);
}
```

#### 4. Context Injection

On session resume or after Compaction detection, provide context to the agent:

```typescript
function buildContextPrompt(context: SessionContext): string {
  return `
[Previous Session Context]
Current task: ${context.summary.currentTask}
Completed: ${context.summary.completedSteps.join(', ')}
Pending: ${context.summary.pendingSteps.join(', ')}
Key decisions: ${context.summary.keyDecisions.join('; ')}
Relevant files: ${context.summary.relevantFiles.join(', ')}
`;
}
```

## Implementation Plan

### Prerequisites

- **Text Log Export Feature** - Required before implementing this feature. Having full session logs in text format enables LLM-based summarization without complex parsing logic.

### Phase 1: Foundation

1. Implement Compaction detection in ActivityDetector
2. Add event emission for Compaction events
3. Create database schema for session context storage

### Phase 2: Context Extraction

1. Integrate with Text Log Export feature
2. Implement LLM summarization service
3. Create scheduled/triggered context extraction

### Phase 3: Context Restoration

1. Implement context injection on session resume
2. Add UI indicators for context-aware sessions
3. Create manual "refresh context" action

### Phase 4: Refinement

1. Tune summarization prompts based on usage
2. Optimize storage and retrieval
3. Add user preferences for context management

## Technical Considerations

### Compaction Detection Reliability

Claude Code's output format may change. The detection logic should:
- Use multiple patterns for resilience
- Log unrecognized patterns for future updates
- Fail gracefully (context extraction still works on schedule)

### Summarization Quality

The quality of context restoration depends on summarization. Consider:
- Structured prompts that extract specific information
- Validation of extracted data
- Fallback to raw log snippets if parsing fails

### Cost Management

LLM calls for summarization incur costs:
- Use haiku (lowest cost) for summarization
- Batch summarization when possible
- Cache summaries until session changes

### Privacy and Storage

Session context may contain sensitive information:
- Store locally (no cloud sync by default)
- Respect session deletion (cascade delete context)
- Consider encryption for stored context

## Future Considerations

- **Cross-session learning**: Identify patterns across sessions
- **Proactive context refresh**: Summarize before hitting limits
- **User-configurable extraction**: Let users define what's important
- **Integration with Claude Code Hooks**: Optionally use PreCompact hook for more precise timing

## References

- [Claude Code Hooks Documentation](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [Logging System Design](./logging-system-design.md)
- [Worker Restore Design](./worker-restore-design.md)
