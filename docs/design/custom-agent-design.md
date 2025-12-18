# Custom Agent Registration Design

This document analyzes CLI behavior patterns of major AI coding agents and evaluates the current `AgentDefinition` design for extensibility.

## AI Coding Agent CLI Patterns Survey

### 1. Aider (aider-chat)

**Startup Command**
```bash
aider [files...]
aider --model sonnet --api-key anthropic=<key>
```

**Prompt/Task Passing**
- Interactive mode (default): Launch with `aider`, then enter commands at `>` prompt
- Non-interactive: `--message "task"` or `-m "task"`
- From file: `--message-file <file>` or `-f <file>`
- In-chat commands: `/add`, `/drop`, `/chat-mode`, `/code`, `/ask`, etc.

**Session Continuation**
- `--restore-chat-history` - Restore previous session
- `--load` - Load chat history
- `/undo` - Undo changes
- Auto Git integration preserves change history

**Headless Mode**
```bash
aider --message "add descriptive docstrings" file.py --yes
aider -m "fix bugs" --auto-commits --dry-run
```

Key options:
- `--yes` / `--yes-always` - Auto-approve all confirmations
- `--auto-commits` - Auto Git commit
- `--dry-run` - Preview changes only
- `--exit` - Exit after initial operation

**User Input Detection**
- Prompt pattern: `> ` (normal mode) or `multi> ` (multi-line mode)
- Control-C for interruption

**Official Documentation**: https://aider.chat/

---

### 2. GitHub Copilot CLI

**Note**: The legacy `gh copilot` extension was deprecated on October 25, 2025, replaced by the new "GitHub Copilot CLI". The `gh-copilot` repository is archived.

**Availability**
- Available on all GitHub Copilot plans (Free/Pro/Business/Enterprise)
- Free plan limited to 50 requests/month
- Native support in Windows Terminal Canary

**Official Documentation**: https://docs.github.com/en/copilot/github-copilot-in-the-cli

---

### 3. OpenHands (formerly OpenDevin)

**Installation and Startup**
```bash
# Via uv (recommended)
uv tool install openhands --python 3.12
openhands

# Executable binary
chmod +x ./openhands
./openhands
```

**CLI Mode (Interactive)**
```bash
openhands
```
- First launch configures LLM settings interactively
- `/settings` - Settings management
- `/mcp` - MCP server management
- `/new` - Create new conversation
- `/help` - Show help
- Conversation history saved in `~/.openhands/conversations`

**Headless Mode (Non-interactive)**
```bash
# Basic usage
poetry run python -m openhands.core.main -t "task content"

# With repository
poetry run python -m openhands.core.main \
  --selected-repo "owner/repo-name" \
  -t "task content"

# Docker execution
docker run -it \
    -e LLM_MODEL="anthropic/claude-sonnet-4-20250514" \
    -e LLM_API_KEY=$LLM_API_KEY \
    docker.openhands.dev/openhands/openhands:0.62 \
    python -m openhands.core.main -t "task"
```

**Key Options**
- `-t "task"` - Task via command line argument
- `-f task.txt` - Task from file
- `-d "/path/to/workspace"` - Working directory
- `-i 50` - Max iterations
- `-b 10.0` - Budget limit (USD)
- `--no-auto-continue` - Enable interactive mode (disable auto-continue)
- `--name` - Session name

**Official Documentation**: https://docs.openhands.dev/

---

### 4. SWE-agent

**Startup Command**
```bash
sweagent run \
  --agent.model.name=claude-sonnet-4-20250514 \
  --env.repo.github_url=https://github.com/owner/repo \
  --problem_statement.github_url=https://github.com/owner/repo/issues/1

sweagent run-batch  # Batch processing
```

**Subcommands**
- `run` / `r` - Run single problem
- `run-batch` / `b` - Batch process multiple problems
- `run-replay` - Replay trajectory
- `traj-to-demo` - Convert trajectory to demo format
- `run-api` - Start GUI backend
- `inspect` / `i` - Terminal-based trajectory viewer
- `inspector` / `I` - Web-based viewer
- `shell` / `sh` - Interactive shell mode

**Task Specification**
- GitHub URL: `--problem_statement.github_url=<URL>` auto-fetches issue description
- Custom text: Direct problem statement
- From file: Specify text file

**Official Documentation**: https://swe-agent.com/

---

### 5. Continue.dev (`cn`)

**Installation and Startup**
```bash
npm install -g @continuedev/cli
cn
```

**TUI Mode (Interactive)**
```bash
cn
```
- Real-time conversation
- `@` prefix for file references
- `/` prefix for slash commands
- Enter to send, Alt+Enter for newline (normal mode)
- Confirmation prompt before tool execution (file writes, terminal commands, etc.)

**Headless Mode (Automation)**
```bash
cn -p "Generate a conventional commit message for staged changes"
cn -p "Fix all TypeScript errors in src/ directory"
```

**Tool Permissions**
- **allow**: Auto-execute
- **ask**: User confirmation required (TUI only)
- **exclude**: Not accessible to AI

In headless mode, tools with "ask" permission are automatically excluded.

**Official Documentation**: https://docs.continue.dev/

---

### 6. Cline (formerly Claude Dev)

**Installation and Startup**
```bash
npm install -g cline
cline auth  # Initial authentication
```

**Basic Usage**
```bash
# Interactive mode
cline

# Direct command mode
cline "Add unit tests to utils.js"
```

**Key Commands**

Authentication:
```bash
cline auth [provider] [key]
cline a [provider] [key]
```

Instance management:
```bash
cline instance new [-d|--default]
cline instance list
cline instance default <address>
cline instance kill <address> [-a|--all]
```

Task management:
```bash
cline task new <prompt> [options]
cline task open <task-id> [options]
cline task list
cline task chat
cline task send [message] [options]
cline task view [-f|--follow] [-c|--follow-complete]
cline task restore <checkpoint>
cline task pause
```

**Instant Task Mode**
```bash
cline "prompt here" [options]
```

Options:
- `-o, --oneshot` - Exit autonomously after task completion
- `-y, --yolo` - Full autonomous mode (disable interaction prompts)
- `-m, --mode` - Start in act or plan mode
- `-s, --setting <key> <value>` - Override task settings

**Global Options**
- `-F, --output-format` - Output format: rich (default), json, plain
- `-h, --help` - Show help
- `-v, --verbose` - Enable debug output

**System Requirements**: Node.js 18.0.0+, macOS/Linux (Windows support planned)

**Official Documentation**: https://docs.cline.bot/

---

### 7. Cursor

**No CLI Mode**: Cursor is provided as an "AI-integrated editor" without a command-line interface. No CLI functionality found in official repository or documentation.

**Official Site**: https://cursor.com/

---

### 8. gpt-engineer

**Installation and Startup**
```bash
python -m pip install gpt-engineer

# Basic usage
gpte <project_dir>
```

**Usage Pattern**
1. Create project folder
2. Write instructions in `prompt` file (no extension)
3. Run `gpte projects/my-new-project`

**Key Options**
- `gpte <project_dir>` - Generate new code
- `gpte <project_dir> -i` - Improve existing code
- `--use-custom-preprompts` - Use custom pre-prompts
- `--image_directory` - Image input directory
- Model selection parameters

**Official Repository**: https://github.com/gpt-engineer-org/gpt-engineer

---

### 9. smol-ai/developer

**Installation and Startup**
```bash
pip install smol_dev

# CLI usage
python main.py "a HTML/JS/CSS Tic Tac Toe Game"
python main.py --prompt prompt.md --debug True
```

**Command Line Arguments**
- `--prompt` (string) - Application instructions (default: Pong game example)
- `--model` (string) - LLM to use (default: `gpt-4-0613`)
- `--generate_folder_path` (string) - Output directory (default: `generated`)
- `--debug` (boolean) - Debug mode (default: `False`)

**Official Repository**: https://github.com/smol-ai/developer

---

## Common Pattern Analysis

### Startup Method Trends
1. **Interactive as default**: Aider, OpenHands CLI, Continue TUI, Cline
2. **Task-specification type**: SWE-agent, OpenHands headless, gpt-engineer
3. **Both supported**: Continue.dev, Cline, OpenHands

### Prompt Passing Patterns
- **Command line argument**: `--message`, `-t`, `-p`, `--prompt`
- **From file**: `--message-file`, `-f`, `prompt` file
- **Interactive prompt**: Input at `>` or dedicated prompt after startup
- **stdin**: OpenHands, some tools

### Headless Mode Implementation
- **Explicit flags**: `--yes`, `--yolo`, `--oneshot`, `--no-auto-continue`
- **Command separation**: `run` vs `run-batch`, TUI vs headless
- **Auto-approval**: Tool permissions, confirmation skip options

### User Input Detection Methods
- **Prompt patterns**: `> `, `multi> ` (Aider)
- **Interactive sessions**: Waiting for commands like `/help`, `/settings`
- **Blocking input**: `io.get_input()`, stdin reading
- **State management**: Session ID, conversation history, checkpoints

---

## New Design

### Design Goals

1. **User-controlled flexibility**: Users can define how to invoke any agent via templates
2. **Simple data model**: Configuration is pure data (JSON-serializable)
3. **Replaceable behavior**: Built-in agents can override default behavior via function maps
4. **Graceful degradation**: Missing optional templates disable specific features

### Architecture: Pattern C (Function Map with Override)

Behavior functions are separate from configuration data. Built-in agents can override default implementations.

```typescript
// === Behavior function types ===
type BuildCommand = (agent: AgentDefinition, opts: CommandBuildOptions) => ExpandTemplateResult;
type RunHeadlessMode = (agent: AgentDefinition, prompt: string, cwd: string) => Promise<HeadlessModeResult>;

// === Default implementations (template-based) ===
const defaultBuildCommand: BuildCommand = (agent, opts) => {
  // Use expandTemplate() to interpret template
  return expandTemplate({
    template: opts.continueConversation ? agent.continueTemplate : agent.commandTemplate,
    prompt: opts.prompt,
    cwd: opts.cwd,
  });
};

// === Built-in overrides (if needed) ===
const builtInOverrides: Record<string, Partial<AgentFunctions>> = {
  'claude-code-builtin': {
    // Override specific functions if default doesn't work
  },
};

// === Usage ===
function getAgentFunctions(agentId: string): AgentFunctions {
  const overrides = builtInOverrides[agentId] ?? {};
  return {
    buildCommand: overrides.buildCommand ?? defaultBuildCommand,
    runHeadlessMode: overrides.runHeadlessMode ?? defaultRunHeadlessMode,
  };
}
```

### AgentDefinition Type Definition

```typescript
type AgentDefinition = {
  id: string;
  name: string;
  description?: string;

  // === Templates ===

  /**
   * Command template for starting a new session with initial prompt.
   * REQUIRED.
   *
   * Placeholders:
   *   {{prompt}} - Insert the initial prompt (passed via environment variable)
   *   {{cwd}} - Insert the working directory path
   *
   * Examples:
   *   "claude {{prompt}}"
   *   "aider --yes -m {{prompt}}"
   *   "cline {{prompt}}"
   */
  commandTemplate: string;

  /**
   * Command template for continuing an existing conversation.
   * OPTIONAL. If not set, "Continue" button is disabled for this agent.
   *
   * Placeholders:
   *   {{cwd}} - Insert the working directory path (if needed)
   *
   * Examples:
   *   "claude -c"
   *   "aider --yes --restore-chat-history"
   */
  continueTemplate?: string;

  /**
   * Command template for headless (non-interactive) execution.
   * Used for metadata generation (branch name, title suggestion).
   * OPTIONAL. If not set, automatic metadata generation is skipped.
   *
   * Placeholders:
   *   {{prompt}} - Insert the prompt (passed via environment variable)
   *   {{cwd}} - Insert the working directory path (if needed)
   *
   * Examples:
   *   "claude -p --output-format text {{prompt}}"
   *   "aider --yes -m {{prompt}} --exit"
   */
  headlessTemplate?: string;

  // === Activity Detection (Optional) ===

  /**
   * Patterns to detect when agent is waiting for user input.
   * OPTIONAL. If not set, agent state is limited to idle/working only.
   *
   * Built-in agents (Claude Code) have accurate patterns defined.
   * Custom agents can optionally configure this, but it's difficult to get right.
   */
  activityPatterns?: {
    askingPatterns: string[];
  };

  // === Metadata ===
  isBuiltIn: boolean;
  registeredAt: string;

  // === Computed (read-only, set by server) ===

  /**
   * Capability flags computed from templates.
   * Clients use these to enable/disable UI features.
   */
  capabilities: {
    supportsContinue: boolean;           // true if continueTemplate is non-empty
    supportsHeadlessMode: boolean;       // true if headlessTemplate is non-empty
    supportsActivityDetection: boolean;  // true if askingPatterns has at least one non-empty pattern
  };
};
```

### Template Syntax

| Placeholder | Description |
|-------------|-------------|
| `{{prompt}}` | Insert the initial prompt (passed via environment variable) |
| `{{cwd}}` | Insert the working directory path (if needed) |

**Important**: Do NOT quote `{{prompt}}` in templates. It is automatically wrapped with double quotes during expansion.

```
CORRECT:   aider -m {{prompt}}
           → aider -m "$__AGENT_PROMPT__"

INCORRECT: aider -m "{{prompt}}"
           → aider -m ""$__AGENT_PROMPT__""  (broken)

INCORRECT: aider -m '{{prompt}}'
           → aider -m '"$__AGENT_PROMPT__"'  (not expanded)
```

**Note**: Pipe stdin (`echo "..." | cmd`) and interactive input simulation (delayed pty.write) are intentionally NOT supported. All surveyed agents support argument-based prompt passing.

### Feature Availability by Template

| Template | Required | If Missing |
|----------|----------|------------|
| `commandTemplate` | Yes | Cannot start agent |
| `continueTemplate` | No | "Continue" button disabled (greyed out) |
| `headlessTemplate` | No | Automatic metadata generation skipped |

### Activity State Detection

| Agent Type | Available States | Reason |
|------------|------------------|--------|
| Built-in (Claude Code) | idle / working / **waiting** | Accurate `askingPatterns` defined |
| Custom agents | idle / working | Users cannot reliably configure `askingPatterns` |

Custom agents MAY configure `activityPatterns.askingPatterns`, but it's optional and for advanced users only.

---

## Concrete Examples

### Claude Code (Built-in)

```json
{
  "id": "claude-code-builtin",
  "name": "Claude Code",
  "commandTemplate": "claude {{prompt}}",
  "continueTemplate": "claude -c",
  "headlessTemplate": "claude -p --output-format text {{prompt}}",
  "activityPatterns": {
    "askingPatterns": ["❯", "?", "Do you want", "waiting for input"]
  },
  "isBuiltIn": true
}
```

### Aider

```json
{
  "name": "Aider",
  "commandTemplate": "aider --yes -m {{prompt}}",
  "continueTemplate": "aider --yes --restore-chat-history",
  "headlessTemplate": "aider --yes -m {{prompt}} --exit",
  "activityPatterns": {
    "askingPatterns": ["> ", "multi> "]
  },
  "isBuiltIn": false
}
```

### Cline

```json
{
  "name": "Cline",
  "commandTemplate": "cline {{prompt}}",
  "continueTemplate": "cline task open",
  "isBuiltIn": false
}
```

### OpenHands

```json
{
  "name": "OpenHands",
  "commandTemplate": "openhands -t {{prompt}}",
  "isBuiltIn": false
}
```

Note: OpenHands example has no `continueTemplate` or `headlessTemplate`, so:
- "Continue" button will be disabled
- Automatic metadata generation will be skipped

### Continue.dev

```json
{
  "name": "Continue.dev",
  "commandTemplate": "cn -p {{prompt}}",
  "isBuiltIn": false
}
```

---

## UI Design

### Add Agent Form

```
┌───────────────────────────────────────────────────────────────┐
│ Add New Agent                                                 │
├───────────────────────────────────────────────────────────────┤
│ Name:                                                         │
│ [Aider                                                     ]  │
│                                                               │
│ Description (optional):                                       │
│ [GPT/Claude pair programming tool                          ]  │
│                                                               │
│ Command Template:                                             │
│ [aider --yes -m {{prompt}}                                 ]  │
│ ℹ️ Use {{prompt}} where the initial prompt should be inserted │
│                                                               │
│ Continue Template (optional):                                 │
│ [aider --yes --restore-chat-history                        ]  │
│ ℹ️ Command to resume a conversation. Leave empty to disable.  │
│                                                               │
│ ▶ Advanced Settings                                           │
│   Headless Template:                                          │
│   [aider --yes -m {{prompt}} --exit                        ]  │
│   ℹ️ For headless execution (branch name generation)          │
│                                                               │
│   Asking Patterns (comma-separated):                          │
│   [> , multi>                                              ]  │
│   ℹ️ Patterns that indicate agent is waiting for input        │
│                                                               │
│ [Cancel]                                        [Add Agent]   │
└───────────────────────────────────────────────────────────────┘
```

### Agent List with Feature Indicators

```
┌───────────────────────────────────────────────────────────────┐
│ Agents                                          [+ Add Agent] │
├───────────────────────────────────────────────────────────────┤
│ Claude Code                                        [built-in] │
│ claude {{prompt}}                                             │
│ ✓ Continue  ✓ Headless  ✓ Activity Detection                 │
│                                                    [Delete]   │
├───────────────────────────────────────────────────────────────┤
│ Aider                                                         │
│ aider --yes -m {{prompt}}                                     │
│ ✓ Continue  ✓ Headless  ✓ Activity Detection                 │
│                                                    [Delete]   │
├───────────────────────────────────────────────────────────────┤
│ OpenHands                                                     │
│ openhands -t {{prompt}}                                       │
│ ✗ Continue  ✗ Headless  ✗ Activity Detection                 │
│                                                    [Delete]   │
└───────────────────────────────────────────────────────────────┘
```

---

## Validation

### Template Validation Rules

| Rule | Applied To | Error Message |
|------|-----------|---------------|
| Must contain `{{prompt}}` | `commandTemplate` | "Command template must contain {{prompt}} placeholder" |
| Must contain `{{prompt}}` | `headlessTemplate` (if set) | "Headless template must contain {{prompt}} placeholder" |
| Must NOT contain `{{prompt}}` | `continueTemplate` (if set) | "Continue template should not contain {{prompt}}" |
| `{{prompt}}` must NOT be quoted | `commandTemplate`, `headlessTemplate` | "{{prompt}} should not be quoted - it is automatically wrapped" |
| Placeholders must not have spaces | All templates | "Use exactly {{prompt}} or {{cwd}} (no spaces inside braces)" |
| Valid shell syntax | All templates | "Invalid command syntax" |

### Registration-time Validation

```typescript
// Helper to check if {{prompt}} is quoted
const isPromptQuoted = (val: string) =>
  val.includes('"{{prompt}}"') || val.includes("'{{prompt}}'");

// Helper to detect malformed placeholders with spaces (e.g., {{ prompt }}, {{  cwd}})
const hasMalformedPlaceholder = (val: string) =>
  /\{\{\s+\w+\s*\}\}|\{\{\s*\w+\s+\}\}/.test(val);

// In CreateAgentRequestSchema
commandTemplate: v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Command template is required'),
  v.custom(
    (val) => !hasMalformedPlaceholder(val),
    'Use exactly {{prompt}} or {{cwd}} (no spaces inside braces)'
  ),
  v.custom(
    (val) => val.includes('{{prompt}}'),
    'Command template must contain {{prompt}} placeholder'
  ),
  v.custom(
    (val) => !isPromptQuoted(val),
    '{{prompt}} should not be quoted - it is automatically wrapped'
  )
),
continueTemplate: v.optional(v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.custom(
    (val) => !hasMalformedPlaceholder(val),
    'Use exactly {{prompt}} or {{cwd}} (no spaces inside braces)'
  ),
  v.custom(
    (val) => !val.includes('{{prompt}}'),
    'Continue template should not contain {{prompt}}'
  )
)),
headlessTemplate: v.optional(v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.custom(
    (val) => !hasMalformedPlaceholder(val),
    'Use exactly {{prompt}} or {{cwd}} (no spaces inside braces)'
  ),
  v.custom(
    (val) => val.includes('{{prompt}}'),
    'Headless template must contain {{prompt}} placeholder'
  ),
  v.custom(
    (val) => !isPromptQuoted(val),
    '{{prompt}} should not be quoted - it is automatically wrapped'
  )
)),
```

### Shell Injection Prevention

Template is executed via shell, but user input (prompt) is passed via environment variable to prevent injection:

```typescript
const PROMPT_ENV_VAR = '__AGENT_PROMPT__';

type ExpandTemplateOptions = {
  template: string;
  prompt?: string;
  cwd: string;
};

type ExpandTemplateResult = {
  command: string;
  env: Record<string, string>;
};

class TemplateExpansionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateExpansionError';
  }
}

function expandTemplate(options: ExpandTemplateOptions): ExpandTemplateResult {
  const { template, prompt, cwd } = options;

  if (!template || template.trim().length === 0) {
    throw new TemplateExpansionError('Template is empty');
  }

  let command = template;
  const env: Record<string, string> = {};

  // Expand {{cwd}} - direct substitution (safe, not user input)
  if (command.includes('{{cwd}}')) {
    command = command.replace(/\{\{cwd\}\}/g, cwd);
  }

  // Expand {{prompt}} - via environment variable (user input, must be protected)
  if (command.includes('{{prompt}}')) {
    if (!prompt) {
      throw new TemplateExpansionError('Template requires {{prompt}} but no prompt provided');
    }
    command = command.replace(/\{\{prompt\}\}/g, `"$${PROMPT_ENV_VAR}"`);
    env[PROMPT_ENV_VAR] = prompt;
  }

  // Validate result is non-empty
  if (!command.trim()) {
    throw new TemplateExpansionError('Template expansion resulted in empty command');
  }

  return { command, env };
}

// Usage
try {
  const { command, env } = expandTemplate({
    template: agent.commandTemplate,
    prompt: userPrompt,
    cwd: sessionCwd,
  });
  pty.spawn('sh', ['-c', command], {
    cwd,
    env: { ...process.env, ...env },
  });
} catch (error) {
  if (error instanceof TemplateExpansionError) {
    // Handle template error (e.g., return 400 Bad Request)
    throw new ValidationError(`Template expansion failed: ${error.message}`);
  }
  throw error;
}
```

**Why this is safe:**
- User input (prompt) never appears directly in the shell command string
- `$__AGENT_PROMPT__` is expanded by the shell from the environment
- Even if prompt contains `"; rm -rf /; "`, it's treated as a literal string value
- `{{cwd}}` is safe because it's a server-controlled value, not user input
- Shell syntax in the template (quotes, pipes, etc.) works naturally

---

## API Contract

### Capabilities Field

Server computes capability flags from templates and includes them in API responses.
Clients use these flags to enable/disable UI features (e.g., graying out "Continue" button).

```typescript
// Server-side helper
function computeCapabilities(agent: AgentDefinition): AgentDefinition['capabilities'] {
  return {
    // Template must be non-empty string after trim
    supportsContinue: Boolean(agent.continueTemplate?.trim()),
    supportsHeadlessMode: Boolean(agent.headlessTemplate?.trim()),
    // Must have at least one non-empty pattern
    supportsActivityDetection: Boolean(
      agent.activityPatterns?.askingPatterns?.some((p) => p.trim().length > 0)
    ),
  };
}
```

**Evaluation rules:**
- `supportsContinue`: `true` if `continueTemplate` is a non-empty string after trimming
- `supportsHeadlessMode`: `true` if `headlessTemplate` is a non-empty string after trimming
- `supportsActivityDetection`: `true` if `askingPatterns` array contains at least one non-empty string

### Agent Deletion with Usage Check

DELETE endpoint checks if agent is in use and rejects deletion if so:

```typescript
// DELETE /api/agents/:id
api.delete('/agents/:id', (c) => {
  const agentId = c.req.param('id');
  const agent = agentManager.getAgent(agentId);

  if (!agent) throw new NotFoundError('Agent');
  if (agent.isBuiltIn) throw new ValidationError('Built-in agents cannot be deleted');

  // Check if in use
  const usingSessions = sessionManager.getSessionsUsingAgent(agentId);
  if (usingSessions.length > 0) {
    return c.json({
      error: 'AGENT_IN_USE',
      message: 'Agent is currently in use',
      sessions: usingSessions.map(s => ({ id: s.id, name: s.name }))
    }, 409);
  }

  agentManager.unregisterAgent(agentId);
  broadcastAgentDeleted(agentId);
  return c.json({ success: true });
});
```

Client displays error with session names if deletion fails.

### WebSocket Events

Add agent-related events to dashboard WebSocket:

| Event | Payload | Trigger |
|-------|---------|---------|
| `agents-sync` | `{ agents: AgentDefinition[] }` | On WebSocket connect (like `sessions-sync`) |
| `agent-created` | `{ agent: AgentDefinition }` | After `POST /api/agents` |
| `agent-updated` | `{ agent: AgentDefinition }` | After `PATCH /api/agents/:id` |
| `agent-deleted` | `{ agentId: string }` | After `DELETE /api/agents/:id` |

**Connection Lifecycle:**
1. On dashboard WebSocket connect, server sends `agents-sync` with full agent list
2. Client replaces local agent state with received data
3. Subsequent changes use incremental events (`agent-created`, `agent-updated`, `agent-deleted`)

**Broadcast Scope:**
- Agent events are broadcast to **all connected dashboard clients** (not scoped to specific sessions)
- Agents are global resources, not session-specific

**Reliability:**
- Events are best-effort (WebSocket nature)
- On reconnect, client receives full `agents-sync` to reconcile state
- Client should use React Query's invalidation to refetch on error

---

## Error Handling

### Headless Mode Unavailable

When user creates a session with prompt and selected agent lacks `headlessTemplate`:

```typescript
// In session creation flow
if (initialPrompt && !agent.capabilities.supportsHeadlessMode) {
  // Skip automatic metadata generation
  // Use fallback branch name: `task-${timestamp}`
  // Include warning in response
  return {
    session,
    warnings: [{
      code: 'HEADLESS_MODE_UNAVAILABLE',
      message: `Agent "${agent.name}" cannot suggest branch names. Using default.`
    }]
  };
}
```

Client displays warning toast but continues with session creation.

### Continue Unavailable

In restart dialog, disable "Continue" button based on capabilities:

```typescript
// RestartSessionDialog.tsx
const canContinue = agent?.capabilities.supportsContinue ?? false;

<Button
  onClick={() => handleRestart(true)}
  disabled={isSubmitting || !canContinue}
>
  Continue
</Button>

{!canContinue && (
  <p className="text-xs text-slate-400">
    This agent does not support conversation continuation
  </p>
)}
```

---

## Security Considerations

### Template Trust Model

Templates are executed in the user's shell with full user privileges. This is by design - users must be able to configure arbitrary agent invocations.

**Trust Boundary:**
- Templates are stored in local config file (`~/.agent-console/agents.json`)
- User has full control over the config file
- Any attack that can modify the config file can already execute arbitrary code (e.g., modifying `.bashrc`)
- Therefore, templates are trusted without additional sandboxing

**Prompt Injection Protection:**
- User-provided prompts are passed via environment variable, not embedded in shell command
- This prevents shell injection even if prompt contains malicious shell syntax
- See `expandTemplate()` implementation above

**User Guidance:**
- Do not copy-paste templates from untrusted sources
- Review templates before saving
- Templates have same trust level as shell aliases or scripts

---

## Implementation Checklist

### Phase 1: Core Types and Validation
- [ ] Update `AgentDefinition` type with template fields and `capabilities` in `packages/shared`
- [ ] Add template validation to `CreateAgentRequestSchema` and `UpdateAgentRequestSchema`
- [ ] Implement `computeCapabilities()` helper

### Phase 2: Server-side Changes
- [ ] Update `AgentManager` to use new format
- [ ] Implement `expandTemplate()` with environment variable injection
- [ ] Add `SessionManager.getSessionsUsingAgent()` method
- [ ] Update `DELETE /api/agents/:id` to check usage and return 409 if in use
- [ ] Update `SessionManager.initializeAgentWorker()` to use templates
- [ ] Update `suggestSessionMetadata()` to use `headlessTemplate`
- [ ] Add WebSocket events for agent changes

### Phase 3: Client-side Changes
- [ ] Update `AgentManagement` form with template fields
- [ ] Add capability indicators to agent list
- [ ] Subscribe to agent WebSocket events
- [ ] Update `RestartSessionDialog` to check `supportsContinue`
- [ ] Handle `HEADLESS_MODE_UNAVAILABLE` warning in session creation

### Phase 4: Testing
- [ ] Unit tests for template validation (including malformed placeholder detection)
- [ ] Unit tests for template expansion (env var injection, {{cwd}}, special characters in prompt)
- [ ] Integration tests for agent CRUD with capabilities
- [ ] E2E tests for Continue button enable/disable

---

## References

- [Aider Documentation](https://aider.chat/)
- [GitHub Copilot CLI Documentation](https://docs.github.com/en/copilot/github-copilot-in-the-cli)
- [OpenHands Documentation](https://docs.openhands.dev/)
- [SWE-agent Documentation](https://swe-agent.com/)
- [Continue.dev Documentation](https://docs.continue.dev/)
- [Cline Documentation](https://docs.cline.bot/)
- [gpt-engineer Repository](https://github.com/gpt-engineer-org/gpt-engineer)
- [smol-ai/developer Repository](https://github.com/smol-ai/developer)
