# Claude Code Subagent Limitations Research

**Investigation Date:** 2025-12-25
**Context:** Automated parallel review loop implementation

## Summary

Claude Code subagents launched via the `Task` tool with `run_in_background=true` **cannot write or edit files** due to the inability to prompt users for permission in background mode. This limitation fundamentally affects architectures that rely on background subagents performing file I/O operations.

## Background

While implementing an automated review loop system, we attempted to create "streaming reviewer" agents that would:
1. Review code in parallel (background execution)
2. Write findings incrementally to JSONLines files
3. Enable real-time fix dispatching while reviews are ongoing

This architecture required background subagents to write to files independently.

## Investigation Process

### Hypothesis
Background subagents should be able to write files if:
- They have `Write` or `Edit` in their `tools:` definition
- The target directory has appropriate permissions in `.claude/settings.json`

### Test 1: Custom Streaming Reviewer with Write Tool

**Agent Definition:**
```yaml
name: jsonl-streaming-test-reviewer
tools: Read, Grep, Glob, Write
model: sonnet
```

**Execution:**
```javascript
Task(
  subagent_type='jsonl-streaming-test-reviewer',
  prompt='Write issues to .claude/review-queue/jsonl-streaming-test-reviewer.jsonl',
  run_in_background=true
)
```

**Result:** ❌ Failed
- Agent attempted to use Write tool
- All write attempts were auto-denied
- Agent reported: "Write permission was auto-denied"
- File remained empty

### Test 2: Adding Edit Tool

**Hypothesis:** Maybe `Edit` tool works differently than `Write` tool.

**Agent Definition:**
```yaml
tools: Read, Grep, Glob, Edit, Write
```

**Result:** ❌ Failed
- Agent attempted both Edit and Write tools
- Both were auto-denied
- File remained unchanged

### Test 3: Settings.json Permissions

**Added to `.claude/settings.json`:**
```json
{
  "permissions": {
    "allow": [
      "Write(.claude/review-queue/*.jsonl)"
    ]
  }
}
```

**Result:** ❌ No effect
- Subagent permissions are not inherited from settings.json
- Background execution still blocked file writes

### Test 4: backend-specialist in Foreground Mode

**Execution:**
```javascript
Task(
  subagent_type='backend-specialist',
  prompt='Edit /tmp/test-edit.ts',
  run_in_background=false  // Foreground
)
```

**Result:** ✅ Success
- Agent prompted user for permission
- User approved the edit
- File was successfully modified

### Test 5: backend-specialist in Background Mode

**Execution:**
```javascript
Task(
  subagent_type='backend-specialist',
  prompt='Edit .claude/review-queue/jsonl-streaming-test-reviewer.jsonl',
  run_in_background=true  // Background
)
```

**Result:** ❌ Failed
- Agent attempted Edit, Write, and Bash tools
- All were auto-denied
- Agent reported: "All the tools that could modify files (Edit, Write, and Bash) have been auto-denied due to prompts being unavailable"
- File remained unchanged

## Root Cause Analysis

### Permission Model

Claude Code has two execution contexts for agents:

**1. Foreground Execution (`run_in_background=false` or not specified)**
- Agent can prompt user for permission
- User approval required for each file modification
- Interactive workflow - agent blocks until user responds
- File writes succeed after approval

**2. Background Execution (`run_in_background=true`)**
- Agent cannot prompt user (no interactive capability)
- File modification requests are auto-denied
- Enables parallel execution
- File writes always fail

### Why Settings.json Doesn't Help

The `.claude/settings.json` permissions apply to the **primary agent** (the main Claude Code session), not to **subagents** launched via the Task tool. Subagents operate in a sandboxed environment with their own permission model.

### Tool Availability vs. Permission

Having a tool in the agent's `tools:` list means the agent **can attempt** to use it, but doesn't grant **permission** to execute it. The permission check happens at execution time, not at agent definition time.

## Implications

### Architecture Constraints

1. **Parallel Background Agents Cannot Write Files**
   - Any architecture requiring parallel file I/O by subagents is not feasible
   - Examples: Streaming logs, incremental result writing, queue management

2. **Foreground Agents Block Execution**
   - Using foreground agents for parallelism defeats the purpose
   - User must manually approve every file write
   - No true parallelism possible

3. **Communication Patterns**
   - Subagents can communicate results via `TaskOutput` (agent return value)
   - Main coordinator must handle all file I/O
   - Batch processing model required

### Working Patterns

**✅ Viable:**
- Subagents read files freely (Read, Grep, Glob tools work)
- Subagents perform analysis and return results
- Main coordinator writes files based on subagent output
- Sequential foreground agents with user approval

**❌ Not Viable:**
- Parallel subagents writing to shared files
- Background subagents creating/modifying files
- Streaming output from multiple agents
- Queue-based work distribution via files

## Alternative Solutions

### Solution 1: Batch Processing (Recommended)

Main coordinator handles all file I/O:

```
1. Launch N subagents in background (read-only analysis)
2. Wait for all to complete via TaskOutput
3. Main coordinator extracts results from agent outputs
4. Main coordinator writes to files
5. Main coordinator dispatches work
```

**Pros:**
- Works within Claude Code limitations
- True parallelism for analysis phase
- No user interaction required

**Cons:**
- Cannot start fixes until all reviews complete
- Batch mode, not streaming

### Solution 2: Multiple Independent Claude Code Processes

Run separate Claude Code instances (not subagents):

```
Terminal 1: claude code → reviewer-1 → writes file-1.jsonl
Terminal 2: claude code → reviewer-2 → writes file-2.jsonl
Terminal 3: claude code → reviewer-3 → writes file-3.jsonl
Terminal 4: claude code → coordinator → reads all files, dispatches
```

**Pros:**
- Each instance is a primary agent (can write files)
- True parallel execution with file I/O
- Streaming architecture possible

**Cons:**
- Requires external orchestration
- More complex process management
- Higher resource usage (4 Claude Code processes)

### Solution 3: Foreground Sequential Processing

Run agents one at a time in foreground:

```
1. Run reviewer-1 (foreground) → user approves writes
2. Run reviewer-2 (foreground) → user approves writes
3. Run reviewer-3 (foreground) → user approves writes
4. Dispatch fixes
```

**Pros:**
- Simple, works within limitations
- User has visibility and control

**Cons:**
- No parallelism
- Requires manual approval for each write
- Slow for large codebases

## Recommendations

### For This Project (agent-console)

Use **Solution 1 (Batch Processing)** for the automated review loop:
- Reviewers run in parallel (background, read-only)
- Main coordinator writes queue files
- Accept batch processing trade-off

**Future Enhancement:** Consider **Solution 2 (Multi-Process)** if:
- Agent-console's session management can orchestrate multiple Claude Code instances
- The overhead of 3-4 processes is acceptable
- Streaming architecture becomes critical for UX

### General Guidelines

When designing Claude Code agent architectures:

1. **Background agents are read-only** - Treat them as pure analysis workers
2. **Main coordinator owns state** - All file modifications go through primary agent
3. **Plan for batch processing** - Don't assume streaming I/O from subagents
4. **Consider process boundaries** - If true parallel I/O is needed, use independent processes

## Related Documents

- [Multi-Process Parallel Review Architecture](../design/multi-process-parallel-review.md) - Architecture design leveraging independent processes
- [WebSocket Protocol](../design/websocket-protocol.md) - Alternative: Use WebSocket for real-time coordination

## Conclusion

The limitation is fundamental to Claude Code's security model: **background subagents cannot prompt users for permission, therefore cannot write files**. Architectures must be designed with this constraint in mind, either accepting batch processing patterns or using multiple independent Claude Code processes for true parallel file I/O.
