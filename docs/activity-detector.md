# ActivityDetector

Agent activity state machine that monitors terminal output to detect whether an AI agent is actively working, waiting for user input, or idle.

## State Diagram

```
                            ┌─────────────────────────────────────────────┐
                            │                                             │
                            │            ┌──────────────┐                 │
                            │   Enter/   │              │                 │
                            │   ESC      │   unknown    │ (initial)       │
                            │            │              │                 │
                            │            └──────┬───────┘                 │
                            │                   │                         │
                            │                   │ first output            │
                            │                   ▼                         │
 ┌────────────────┐         │            ┌──────────────┐                 │
 │                │◄────────┘            │              │                 │
 │     idle       │◄─────────────────────│    active    │◄────────────────┤
 │                │   no output for      │              │  high output    │
 └───────┬────────┘   noOutputIdleMs     └──────┬───────┘  rate           │
         │                                      │                         │
         │                                      │ asking pattern          │
         │                                      │ detected                │
         │                                      ▼                         │
         │                               ┌──────────────┐                 │
         │                               │              │                 │
         └──────────────────────────────►│   asking     │─────────────────┘
           asking pattern detected       │              │  Enter/ESC
                                         └──────────────┘
```

## State Transitions

| From    | To      | Trigger                                                    |
|---------|---------|-----------------------------------------------------------|
| unknown | active  | First output received                                      |
| idle    | active  | High output rate (>= activeCountThreshold in rateWindowMs) |
| active  | idle    | No output for noOutputIdleMs                               |
| active  | asking  | Asking pattern detected in output                          |
| idle    | asking  | Asking pattern detected in output                          |
| asking  | idle    | User presses Enter (submit) or ESC (cancel)                |

## Timers

- **debounceTimer**: Delays pattern analysis until output stream settles (debounceMs)
- **idleCheckTimer**: Checks for idle transition after noOutputIdleMs of no output
- **userTypingTimer**: Tracks user typing activity to avoid false active detection

## Rate Detection Suppression

When entering 'asking' state, rate-based detection is suppressed to prevent TUI redraws (common in prompts) from triggering 'active' state transitions. Suppression is cleared when user responds (Enter/ESC).

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| bufferSize | 1000 | Max characters to keep in pattern matching buffer |
| debounceMs | 300 | Debounce time before analyzing patterns |
| rateWindowMs | 2000 | Time window for output rate calculation |
| activeCountThreshold | 20 | Output events needed to trigger 'active' state |
| noOutputIdleMs | 2000 | Silence duration to transition to 'idle' |
| userTypingTimeoutMs | 5000 | User typing detection timeout |
