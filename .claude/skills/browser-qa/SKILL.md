---
name: browser-qa
description: Manual browser QA via Chrome DevTools MCP. Use when acceptance criteria include manual verification or UI changes need visual confirmation.
---

# Browser QA

Manual browser verification procedure for UI changes using Chrome DevTools MCP.

## When to Use

- Acceptance criteria include `manual verification`
- PR modifies `packages/client/src/components/`
- Visual or interaction behavior needs confirmation beyond automated tests

## Procedure

### 1. Start Dev Server

```bash
cd <repository-root>
bun run dev
```

**Check the startup log** for the actual port — Vite may auto-increment if the default port (5173) is in use:
```
Port 5173 is in use, trying another one...
  ➜  Local:   http://localhost:5174/
```

Also check `.env` for custom port configuration (`CLIENT_PORT`, `PORT`).

### 2. Navigate to the UI

```
mcp: navigate_page → http://localhost:<port>
mcp: take_screenshot → confirm page loaded
```

For specific pages, navigate directly via client route (SPA routing works):
```
mcp: navigate_page → http://localhost:<port>/sessions/<id>
```

### 3. Interact and Verify

Use Chrome DevTools MCP tools:

| Action | Tool | Tips |
|--------|------|------|
| Click element | `click` | Use `take_snapshot` first to get element UIDs |
| Type text | `type_text` | Click the input first to focus |
| Fill form field | `fill` | Target by UID from snapshot |
| Wait for async | `wait_for` | Wait for selector to appear |
| Check errors | `list_console_messages` | Look for JS errors |
| Screenshot | `take_screenshot` | Capture before/after states |

### 4. Verify Acceptance Criteria

For each `manual verification` criterion:
1. Reproduce the scenario described
2. Take a screenshot confirming the expected behavior
3. Check `list_console_messages` for unexpected errors

### 5. Cleanup

Stop the dev server when done (kill the background process or Ctrl+C).

## Common Issues

- **Port conflict**: Check startup log for actual port. Vite auto-increments.
- **Blank page**: Run `bun run --filter '@agent-console/shared' build` first — client depends on shared types.
- **API errors**: Ensure backend is also running (dev script starts both, but check logs).
