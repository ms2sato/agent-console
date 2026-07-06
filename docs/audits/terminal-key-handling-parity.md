# Terminal Key Handling Parity Audit

Audit of DOM `keydown` → PTY byte sequence conversion in the new `@xterm/headless` + custom DOM renderer stack, against xterm.js's browser-side `evaluateKeyboardEvent` (the code path the legacy `Terminal.tsx` relied on).

## 1. Background

- PR [#962](https://github.com/ms2sato/agent-console/pull/962) removed the legacy xterm.js-based `Terminal.tsx` and promoted the new UI (`TerminalView.tsx` + `TerminalKeyboardInput.tsx`), which uses `@xterm/headless` for the VT core and a self-written React DOM renderer for the visual layer.
- The new UI hand-rolls `keydown` → PTY byte sequence conversion in `packages/client/src/components/terminal/TerminalKeyboardInput.tsx:91-115` (the `handleKeyDown` handler).
- Owner dogfood surfaced a regression: **Shift+Tab** in Claude Code no longer cycles modes (default → auto-accept → plan). Root cause: `handleKeyDown` only inspects `shiftKey` for the Enter branch; every other key ignores the modifier, so Shift+Tab collapses to a plain `\t` instead of the expected backtab sequence `\x1b[Z` (`CSI Z`).
- Shift+Tab is one instance of a systemic gap. AgentConsole runs arbitrary TUIs (Claude Code, vim, less, tmux, bash readline, etc.) through the PTY. Any key sequence that xterm.js used to synthesise browser-side is now silently dropped or degraded.
- This document enumerates every gap between the current handler and xterm.js's `evaluateKeyboardEvent`, categorises them (Critical / Recommended / Optional), and specifies the fix scope + test strategy for Phase B.

## 2. Method

### 2.1 Upstream reference

- Repository: `github.com/xtermjs/xterm.js`
- Master HEAD at audit time: `8aab310366549d8d865bd8fc4bd509051f2bb2a1` (2026-07-06 fetch)
- Primary source: `src/common/input/Keyboard.ts` — the pure function `evaluateKeyboardEvent(ev, applicationCursorMode, isMac, macOptionIsMeta)` that maps `IKeyboardEvent` (thin wrapper over browser `KeyboardEvent`) to a `KeyboardResult { type, cancel, key }`.
- Test oracle: `src/common/input/Keyboard.test.ts` (22 KB) — dense case coverage for the mapping table; used as ground truth for expected byte sequences.
- Escape sequence constants: `src/common/data/EscapeSequences.ts` — `C0.ESC = '\x1b'`, `C0.HT = '\t'`, `C0.CR = '\r'`, `C0.DEL = '\x7f'`, `C0.ETX = '\x03'`, `C0.NUL = '\x00'`, `C0.US = '\x1f'`, `C0.RS = '\x1e'`, `C0.FS = '\x1c'`, `C0.GS = '\x1d'`.
- Modifier bitmask (xterm convention, reused across the CSI encodings): `shift = 1, alt = 2, ctrl = 4, meta = 8`. The CSI parameter is `modifiers + 1` (so Shift alone = `2`, Alt alone = `3`, Ctrl alone = `5`, Ctrl+Shift = `6`, and so on up to `8` for Ctrl+Alt+Shift).

### 2.2 Current implementation surface

`TerminalKeyboardInput.tsx` uses a visually-hidden `<textarea>` and three event handlers to route input to `instance.sendInput(...)`:

- `handleInput` — the default text-input path (IME committed characters, plain typed characters).
- `handleCompositionStart/Update/End` — IME composition tracking; `handleKeyDown` early-returns while `composingRef.current` is true.
- `handleKeyDown` — the special-key path. Contains **three** branches:
  1. `Enter + Shift` → `\n` (deliberate agent-console divergence from xterm's `\r`, needed for Claude Code multi-line prompt entry).
  2. `Ctrl` (no Alt, no Meta) + single-letter `key` → control character in the range `@` (0x00) through `_` (0x1F).
  3. `SPECIAL_KEYS[e.key]` lookup — the map covers only `Enter`, `Backspace`, `Tab`, `Escape`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` and returns the unmodified base sequence for each.
- Every other `keydown` falls through. In practice, plain letters/digits are re-injected by the browser as textarea input and picked up by `handleInput`. Modified special keys (Shift+Tab, Alt+letter, Ctrl+Arrow, Home/End, F1-F12, Delete, Insert, PageUp/Down, ...) are either dropped entirely by the browser or produce the base-key sequence with the modifier silently discarded.

### 2.3 Comparison procedure

For each `keyCode` handled by xterm's `evaluateKeyboardEvent`, we tabulate:

- The xterm.js output byte sequence for the un-modified case and for every meaningful modifier combination (Shift, Ctrl, Alt, and their pairs; Meta is documented only where xterm treats it specially).
- The current implementation's output for the same input (either a value from `SPECIAL_KEYS`, a control character from the Ctrl+letter branch, or `—` meaning "no output emitted from `handleKeyDown`, likely dropped").
- Whether the two agree.
- The category (Critical / Recommended / Optional) and, for Critical entries, a concrete TUI-side symptom.

Meta (Cmd on macOS) is treated conservatively: xterm.js mostly returns `undefined` for Meta-prefixed cases (except `Cmd+A` which triggers an internal `SELECT_ALL` UI action, not PTY output). The current handler also does not emit anything for Meta, so Meta is not called out as a gap.

Bracketed paste is out of scope. Paste is already handled correctly through `instance.paste(...)` (`terminal-store.ts:359-367`), which wraps content in `\x1b[200~ ... \x1b[201~` when the VT core reports `bracketedPasteMode` on.

## 3. Findings

Legend — each row is one `browser keydown` (key + modifier combo); `xterm.js output` is the byte sequence the legacy stack would emit; `current impl output` is what the new handler emits today.

### 3.1 Tab (`keyCode 9`)

| Input | xterm.js output | Current impl output | Gap | Category | Impact example |
|---|---|---|---|---|---|
| `Tab` | `\t` (HT) | `\t` | — | — | OK |
| `Shift+Tab` | `\x1b[Z` (CSI Z, backtab) | `\t` | **CRITICAL** | Critical | Claude Code mode cycle broken (dogfood repro, Issue #985). vim `<S-Tab>` inoperative. bash / readline `menu-complete-backward` inoperative. `less` reverse-tag completion inoperative. |
| `Alt+Tab` | (browser-reserved; not synthesised) | — | — | — | Reserved by OS window manager. |
| `Ctrl+Tab` | (browser-reserved; not synthesised) | — | — | — | Reserved by browser tab switching. |

### 3.2 Arrow keys (`keyCode 37/38/39/40`)

Base sequences (unmodified, non-application cursor mode): `\x1b[A / B / C / D` for Up/Down/Right/Left. Currently emitted correctly.

Modified sequences (xterm.js encodes `\x1b[1;<mod+1><X>` where `<X>` is `A/B/C/D` and `<mod>` is the bitmask above):

| Input | xterm.js output | Current impl output | Gap | Category | Impact example |
|---|---|---|---|---|---|
| `Shift+ArrowUp/Down/Left/Right` | `\x1b[1;2A / B / D / C` | `\x1b[A / B / D / C` (modifier dropped) | modifier lost | Critical | vim visual-mode extension (`<S-Up>` etc.), Claude Code shift-arrow message navigation, most modern editors. |
| `Alt+Arrow*` | `\x1b[1;3<X>` | — (Alt is not caught by `handleKeyDown` and browsers usually swallow Alt+Arrow, so no textarea input either) | modifier + key both lost | Recommended | vim `<M-Left>` bindings, tmux window navigation on some configs, readline `M-b` alternates. |
| `Ctrl+ArrowLeft/Right` | `\x1b[1;5D / C` | `\x1b[D / C` | modifier lost | Critical | bash readline word-motion (Ctrl+←/→ = `backward-word` / `forward-word`) — one of the most common shell shortcuts. vim `<C-Right>`. tmux copy-mode word-motion. |
| `Ctrl+ArrowUp/Down` | `\x1b[1;5A / B` | `\x1b[A / B` | modifier lost | Recommended | tmux pane-resize bindings, some editor scroll bindings. |
| `Ctrl+Shift+Arrow*` | `\x1b[1;6<X>` | base sequence (both modifiers lost) | modifier lost | Recommended | vim `<C-S-Right>` word-select bindings; VS Code-like keymaps in TUI editors. |
| `Meta+Arrow*` | (xterm: no output; explicit `break`) | base sequence (`\x1b[A/B/D/C`) — falls through to `SPECIAL_KEYS[e.key]`, no `metaKey` check | modifier ignored | Recommended | macOS Cmd+Arrow expected as OS-level word-motion / line-jump; the terminal emitting a raw arrow byte confuses TUIs that treat Meta as a distinct modifier. (Audit revision 2026-07-06: initial pass mistakenly recorded "OK — current impl agrees"; verification during Phase B commit 1 showed the current handler has no Meta guard on the `SPECIAL_KEYS` lookup path. Phase B fixes this by explicitly returning on `metaKey` before the arrow branch.) |

### 3.3 Backspace (`keyCode 8`)

| Input | xterm.js output | Current impl output | Gap | Category | Impact example |
|---|---|---|---|---|---|
| `Backspace` | `\x7f` (DEL) | `\x7f` | — | — | OK |
| `Ctrl+Backspace` | `\b` (0x08, ^H) | `\x7f` | wrong byte | Recommended | vim / bash: some configurations bind `\b` to `delete-word-backward`. Divergence is subtle but real. |
| `Alt+Backspace` | `\x1b\x7f` (or `\x1b\b` if Ctrl also held) | `\x7f` | modifier lost | Critical | readline `backward-kill-word` (a.k.a. Alt+BS) — heavily used in bash / zsh. Claude Code input line editing. |
| `Shift+Backspace` | `\x7f` (xterm ignores Shift here) | `\x7f` | — | — | OK by coincidence. |

### 3.4 Enter (`keyCode 13`)

| Input | xterm.js output | Current impl output | Gap | Category | Impact example |
|---|---|---|---|---|---|
| `Enter` | `\r` (CR) | `\r` | — | — | OK |
| `Shift+Enter` | `\r` (xterm ignores Shift) | `\n` | **intentional divergence** | — | agent-console deliberate override — Claude Code expects `\n` to insert a soft newline in its prompt buffer. Documented as an agent-console-specific behavior; **not a regression** and Phase B preserves it. |
| `Alt+Enter` | `\x1b\r` (ESC + CR) | `\r` (Alt ignored) | modifier lost | Recommended | vim `<M-CR>`, some TUI form-submit bindings. |
| `Ctrl+Enter` | `\r` (xterm does not special-case; but Safari-on-iOS special: Ctrl+`c`-as-Enter → ETX, see xterm source) | `\r` | — | Optional | Edge case (Safari/iPad hardware keyboard); not covered here. |

### 3.5 Escape (`keyCode 27`)

| Input | xterm.js output | Current impl output | Gap | Category | Impact example |
|---|---|---|---|---|---|
| `Escape` | `\x1b` | `\x1b` | — | — | OK |
| `Alt+Escape` | `\x1b\x1b` | `\x1b` | modifier lost | Recommended | vim: `<M-Esc>` mappings; some readline configurations. Low frequency. |
| `Shift/Ctrl+Escape` | `\x1b` | `\x1b` | — | — | OK by coincidence. |

### 3.6 Delete / Insert / Home / End / PageUp / PageDown

All six keys are **entirely absent** from the current `SPECIAL_KEYS` map. Physical PC keyboards and many external keyboards have them; laptop compact layouts often expose them through Fn combinations. In the current implementation they either produce nothing (`Delete`, `Insert`, `PageUp`, `PageDown`) or produce a stray character on a few OS/browser combos (typically nothing on macOS Chrome/Safari for `Home`/`End`).

| Input | xterm.js output | Current impl output | Gap | Category | Impact example |
|---|---|---|---|---|---|
| `Delete` (forward delete) | `\x1b[3~` | — | missing | Critical | vim `x` alternative, bash readline `delete-char`, Claude Code input editing. Many external keyboards send Delete as the primary "erase forward" key. |
| `Ctrl/Alt/Shift+Delete` | `\x1b[3;<mod+1>~` | — | missing | Recommended | vim `<C-Del>` bindings; readline `kill-word`. |
| `Insert` | `\x1b[2~` | — | missing | Recommended | vim toggle insert mode via `Insert` (some configs); midnight commander bindings. Note: Shift/Ctrl+Insert are OS copy/paste — xterm.js suppresses PTY output for those, matches current behavior. |
| `Home` | `\x1b[H` (normal), `\x1bOH` (application cursor mode) | — | missing | Critical | bash readline `beginning-of-line`, vim `0`/`gg` alt, less `g`, tmux copy-mode. |
| `End` | `\x1b[F` (normal), `\x1bOF` (application) | — | missing | Critical | bash readline `end-of-line`, vim `$`/`G` alt, less `G`. |
| `Ctrl/Alt/Shift+Home/End` | `\x1b[1;<mod+1>H/F` | — | missing | Recommended | vim `<C-Home>` = document top; editor bindings. |
| `PageUp` | `\x1b[5~` (base); `Shift+PageUp` triggers UI-scroll (internal, not sent) | — | missing | Critical | less / man page navigation, tmux copy-mode paging, vim `<PageUp>`. |
| `PageDown` | `\x1b[6~` (base); `Shift+PageDown` UI-scroll | — | missing | Critical | Same corpus as PageUp. |
| `Ctrl+PageUp/PageDown` | `\x1b[5;<mod+1>~` / `\x1b[6;<mod+1>~` | — | missing | Recommended | tmux window-switch on some configs. |

Note: `Shift+PageUp/PageDown` in xterm.js triggers an internal UI-side scrollback scroll (`KeyboardResultType.PAGE_UP`/`PAGE_DOWN`) rather than sending bytes to the PTY. The new UI already has its own scrollback via `TerminalScrollIndicator` + wheel handling in `TerminalView`, so replicating that internal handler is a separate concern (see §5 Deferred items).

### 3.7 Function keys F1-F12 (`keyCode 112-123`)

All twelve keys are **entirely absent** from the current handler. Both the unmodified base sequences and the modified variants are unreachable.

| Input | xterm.js output | Current impl output | Gap | Category | Impact example |
|---|---|---|---|---|---|
| `F1` | `\x1bOP` | — | missing | Recommended | midnight commander, htop help, vim `<F1>`. |
| `F2` | `\x1bOQ` | — | missing | Recommended | midnight commander rename, htop setup. |
| `F3` | `\x1bOR` | — | missing | Recommended | mc view, htop search. |
| `F4` | `\x1bOS` | — | missing | Recommended | mc edit, htop filter. |
| `F5` | `\x1b[15~` | — | missing | Recommended | mc copy, htop tree, less refresh. |
| `F6` | `\x1b[17~` | — | missing | Recommended | mc move. |
| `F7` | `\x1b[18~` | — | missing | Recommended | mc mkdir, htop search-next. |
| `F8` | `\x1b[19~` | — | missing | Recommended | mc delete, htop kill. |
| `F9` | `\x1b[20~` | — | missing | Recommended | mc menu. |
| `F10` | `\x1b[21~` | — | missing | Recommended | mc quit, htop quit. Browser may intercept (menu bar); best-effort. |
| `F11` | `\x1b[23~` | — | missing | Optional | Browser fullscreen — always intercepted; no PTY reach anyway. |
| `F12` | `\x1b[24~` | — | missing | Optional | Browser devtools — always intercepted. |
| `Ctrl/Alt/Shift+Fn` | `\x1b[1;<mod+1>P/Q/R/S` (F1-F4) or `\x1b[<code>;<mod+1>~` (F5+) | — | missing | Recommended | vim custom mappings, tmux prefix chords. |

### 3.8 Alt + character (`default` branch, mostly readline Meta)

xterm.js sends `\x1b` + the character for Alt-modified letters, digits, and shifted symbols (via `KEYCODE_KEY_MAPPINGS`). The current implementation does not handle Alt at all in `handleKeyDown`; browser textarea input for `Alt+letter` typically produces no text at all (or an OS-inserted special character), so the key is effectively **dropped** on most platforms.

| Input | xterm.js output | Current impl output | Gap | Category | Impact example |
|---|---|---|---|---|---|
| `Alt+<letter>` (a-z) | `\x1b<letter>` (lower/upper as per shift) | — (browser drops or inserts OS special) | missing | Critical | readline Emacs-mode bindings: Alt+B = `backward-word`, Alt+F = `forward-word`, Alt+D = `kill-word`, Alt+. = `yank-last-arg`, etc. Extremely common in bash / zsh interactive shell. vim insert-mode `<M-x>` bindings. |
| `Alt+Shift+<letter>` | `\x1b<UpperLetter>` | — | missing | Recommended | Less common but exists in some Emacs / readline configs. |
| `Alt+<digit>` | `\x1b<digit>` | — | missing | Recommended | readline argument prefix (`Alt+5 Ctrl+D` = kill 5 chars). |
| `Alt+<shifted-digit or symbol>` | `\x1b<shifted>` per `KEYCODE_KEY_MAPPINGS` | — | missing | Recommended | e.g. `Alt+Shift+.` = `\x1b>` (readline `end-of-history`). Same table for `:`, `+`, `_`, `?`, `~`, `{`, `\|`, `}`, `"`, `<`, `>`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`. |
| `Alt+Space` | `\x1b ` (or `\x1b\x00` if Ctrl also held) | — | missing | Optional | Emacs / readline rare bindings. |
| `Alt+<dead key>` (macOS US layout: N/E/U + Alt produces a dead key) | `\x1b<letter>` synthesised from `ev.code` | — | missing | Recommended | macOS-only, but is the primary way `Alt+n / Alt+e / Alt+u` are meant to work in a terminal. |

### 3.9 Ctrl + non-letter (`default` branch)

The current `Ctrl+letter` branch (`code >= 64 && code <= 95`) covers a subset of what xterm.js handles. Gaps:

| Input | xterm.js output | Current impl output | Gap | Category | Impact example |
|---|---|---|---|---|---|
| `Ctrl+A..Z` (letters) | `\x01..\x1a` | `\x01..\x1a` | — | — | OK |
| `Ctrl+@` (`e.key === '@'`, needs Shift on US layouts) | `\x00` (NUL) | `\x00` if the browser reports `e.key === '@'`; otherwise dropped | partial | Recommended | Emacs `set-mark`. On US layout the key is `Shift+2`; xterm handles this via the "Ctrl+Shift+2" branch below. Current impl only catches it when `e.key` happens to be `@`. |
| `Ctrl+Space` | `\x00` (NUL) | — (`e.key === ' '`, `length === 1`, `code = 32`, outside 64-95 range) | missing | Critical | Emacs `set-mark-command`; heavily used. vim `<C-Space>` for `startinsert` in some configs. |
| `Ctrl+3` | `\x1b` (ESC, 27) | — (`code = 51`, outside range) | missing | Recommended | Rare, but the standard "no Escape key" fallback. |
| `Ctrl+4` | `\x1c` (FS, 28) | — | missing | Recommended | Emacs / readline `quoted-insert` alternatives. |
| `Ctrl+5` | `\x1d` (GS, 29) | — | missing | Recommended | tmux prefix on some configs. |
| `Ctrl+6` | `\x1e` (RS, 30) | — | missing | Recommended | vim `<C-6>` = alt buffer. |
| `Ctrl+7` | `\x1f` (US, 31) | — | missing | Recommended | Rare. |
| `Ctrl+8` | `\x7f` (DEL) | — | missing | Optional | Rare. |
| `Ctrl+/` | `\x1f` (US) | — | missing | Recommended | Emacs `undo` (very common in Emacs users; less common in TUI TUIs). Explicit fix in xterm.js Issue #5457. |
| `Ctrl+[` | `\x1b` (ESC) | `\x1b` (falls in 64-95 range: 91) | — | — | OK by coincidence (both handlers emit ESC). |
| `Ctrl+\` | `\x1c` (FS) | `\x1c` (92 in range) | — | — | OK by coincidence. |
| `Ctrl+]` | `\x1d` (GS) | `\x1d` (93 in range) | — | — | OK by coincidence. |
| `Ctrl+^` | `\x1e` (RS) | `\x1e` (94 in range; but `^` normally needs Shift, so `Ctrl+Shift+6` — xterm handles that separately) | partial | Optional | Depends on browser reporting `e.key === '^'` for `Ctrl+Shift+6`. |
| `Ctrl+_` | `\x1f` (US) | `\x1f` (95 in range) | — | — | OK by coincidence. |
| `Ctrl+Shift+2` (US layout `@`) | `\x00` (NUL, via last `else if` branch) | — (`e.key === '@'`; when Shift is held, first branch bails on `!e.shiftKey`) | missing | Recommended | Emacs `set-mark` on US layouts. |
| `Ctrl+Shift+6` (US layout `^`) | `\x1e` (RS) | — (same reason) | missing | Recommended | vim `<C-6>` alternate; Emacs. |
| `Ctrl+Shift+-` (US layout `_`) | `\x1f` (US) | — | missing | Recommended | Emacs `undo`. |

Note: the current Ctrl-branch precondition `!e.altKey && !e.metaKey` is correct and matches xterm.js's `!ev.shiftKey && !ev.altKey && !ev.metaKey` gate (except for the `!e.shiftKey` part — the current impl allows Shift+Ctrl+letter to still emit the control char, whereas xterm.js reserves that for the Ctrl+Shift+2/6/- special forms above). This is a minor divergence; realistic impact is low because typing letters with Shift+Ctrl usually still yields the same control byte (Ctrl+A vs Ctrl+Shift+A both mean 0x01), but it should be tightened alongside the fix.

### 3.10 IME composition

The current handler correctly early-returns while `composingRef.current || e.nativeEvent.isComposing`. This matches xterm.js's IME-safe behaviour. **No gap.**

### 3.11 Application cursor mode (DECCKM)

xterm.js switches arrow keys, `Home`, and `End` between the CSI form (`\x1b[A`) and the SS3 form (`\x1bOA`) depending on whether the app has set application-cursor-mode via DECSET `?1`. This state is tracked by the VT core (`terminal.modes.applicationCursorKeysMode` in `@xterm/headless`). The current implementation always emits the CSI form. Impact:

- Most modern TUIs work fine with the CSI form because they set application-cursor-mode transparently, but a handful (older readline, some `less` builds) key off the SS3 form.
- Category: **Recommended** (implement) or **Optional** (defer). Recommended because it is cheap once we already have the modifier-encoding infrastructure and because at least one dogfood scenario (`bash` up-arrow history recall in some minimal configs) can regress without it.

### 3.12 iOS UIKeyInput\* virtual keys

xterm.js handles `ev.key === 'UIKeyInputUpArrow'` (and Down/Left/Right) as a fallback for iOS Safari when `keyCode === 0`. The current impl relies on `e.key === 'ArrowUp'` etc., which iOS reports correctly on modern versions. Category: **Optional** — no dogfood evidence of iOS regression yet.

### 3.13 macOptionIsMeta

xterm.js exposes a config that turns macOS's Option key into Meta (`\x1b<key>`). Without it, macOS Option enters the third-level shift (typing `∑` for Alt+w, etc.) — this is xterm.js's default on macOS. Because the current impl handles no Alt/Option combos at all, both branches are simultaneously broken. Phase B's Alt handling should adopt `macOptionIsMeta = true` as the default (agent-console runs no localised layouts by default, and treating Option as Meta matches what most Claude Code / vim / bash users on macOS expect from a terminal emulator). Category: **Recommended** default-on, opt-out via preference if a user reports keyboard regression.

## 4. Recommended fix scope (Phase B)

The following gaps must be closed in Phase B. Non-critical items in the same code path are folded in because the incremental cost is minimal once the modifier-encoding helper is in place.

### 4.1 Critical (dogfood-visible breakage)

1. **Shift+Tab** → `\x1b[Z`.
2. **Shift/Ctrl/Alt + Arrow** (all four directions) → `\x1b[1;<mod+1><A|B|C|D>`.
3. **Home / End** (base and with modifiers) → CSI form with modifier tail.
4. **Delete** (forward delete, base and with modifiers) → `\x1b[3~` / `\x1b[3;<mod+1>~`.
5. **PageUp / PageDown** (base and Ctrl-modified) → `\x1b[5~` / `\x1b[6~` and modified forms. Shift+PageUp/Down deferred (see §5).
6. **Alt + letter** (readline Meta) → `\x1b<letter>`, including case handling per Shift and `Dead`-key fallback via `ev.code`.
7. **Alt + Backspace** → `\x1b\x7f` (readline backward-kill-word).
8. **Ctrl + Space** → `\x00` (NUL).

### 4.2 Recommended (cheap once §4.1 lands)

9. **F1-F10** base sequences (F11 / F12 skipped because browsers always intercept).
10. **F1-F10 + modifiers** → CSI modified form.
11. **Alt+digit / Alt+Shift+symbol** via `KEYCODE_KEY_MAPPINGS`-equivalent shift table.
12. **Alt+Enter** → `\x1b\r`.
13. **Alt+Escape** → `\x1b\x1b`.
14. **Ctrl+Backspace** → `\b` (0x08) instead of `\x7f`.
15. **Ctrl+3..7** → `\x1b`, `\x1c`, `\x1d`, `\x1e`, `\x1f` (matches xterm's non-letter Ctrl mappings).
16. **Ctrl+/** → `\x1f` (US).
17. **Ctrl+Shift+2 / 6 / -** → `\x00` / `\x1e` / `\x1f` (US-layout xterm parity).
18. **Insert** → `\x1b[2~` (base only; Shift/Ctrl+Insert remain no-ops for OS copy/paste).
19. **Application cursor mode** — switch between CSI and SS3 forms for arrows / Home / End based on `@xterm/headless`'s `terminal.modes.applicationCursorKeysMode`.
20. **Tighten Ctrl+letter precondition** to `!e.shiftKey` (drop it into the `Ctrl+Shift+2/6/-` branch instead) — bug-fix cleanup, no user-visible change on realistic layouts.
21. **Meta+Arrow no-op guard** — return early on `metaKey` in the arrow branch so `Cmd+ArrowLeft/Right/Up/Down` (macOS OS-level word-motion / line-jump) does not leak a raw arrow byte to the PTY. Matches xterm.js's explicit `break` on Meta. Added during commit 1 test-writing when polarity flip surfaced the actual current behavior (§3.2 revision 2026-07-06).

### 4.3 Non-goals for Phase B

- Kitty keyboard protocol (`KittyKeyboard.ts` in xterm.js). Neither the legacy `Terminal.tsx` nor the current UI enabled it.
- Win32InputMode (`Win32InputMode.ts`). Not enabled.
- Mouse reporting (roadmap PR-2 item, tracked separately in Issue #934 / roadmap).
- Bracketed paste (already handled correctly via `terminal-store.ts:paste`).

## 5. Deferred items (Optional)

Explicitly out of scope for Phase B; documented so future audits do not re-derive them.

| Item | Reason for deferral |
|---|---|
| `Shift+PageUp / Shift+PageDown` UI scrollback | The new UI already has its own scrollback UI via `TerminalScrollIndicator` + wheel handler; the xterm.js internal `PAGE_UP`/`PAGE_DOWN` handler needs to be re-wired to that path, which is a separate PR against the scroll code, not the key handler. Tracked as a follow-up. |
| iOS `UIKeyInputXxxArrow` fallback | No dogfood evidence of iOS regression; modern iOS Safari reports `ArrowUp` etc. correctly. Re-open only if a mobile user reports it. |
| Ctrl+8 → `\x7f` | Very rare; provides a duplicate path for DEL. Skip for parity minimalism. |
| F11 / F12 | Always intercepted by the browser (fullscreen / devtools). Emitting the sequence has no PTY reach. |
| Numpad separate codes | Modern browsers report numpad keys with their symbolic `key` names on all platforms of interest; xterm.js has no dedicated numpad branch either. |
| Kitty keyboard protocol | Not enabled by the VT core; opt-in only. Out of scope. |
| Application keypad mode (DECKPAM) numeric-mode variants | Rarely toggled by TUIs; not covered by the current `SPECIAL_KEYS` regression scope. |
| macOS "Option is not Meta" mode | Phase B defaults `macOptionIsMeta = true`. If a macOS user reports third-level-shift typing loss, expose a preference. |
| Safari-on-iOS `Ctrl+c-as-Enter` hack (`ev.key === 'c' && ev.ctrlKey` under keyCode 13) | Extreme edge case documented in xterm.js source as a workaround for a specific Apple hardware keyboard bug; not observed in agent-console dogfood. |

## 6. Test strategy (Phase B)

The existing `packages/client/src/components/terminal/__tests__/TerminalKeyboardInput.test.tsx` covers **soft-key bar visibility only** (2 `it` blocks). Phase B will add a `describe('handleKeyDown', ...)` block with one `it` per row of §3 for the Critical + Recommended items (§4.1 + §4.2), asserting that a synthesized `KeyboardEvent` produces the expected `instance.sendInput(...)` call.

Test infrastructure sketch (for the report; final shape decided in Phase B):

- Mount `<TerminalKeyboardInput instance={mockInstance} />` with `mockInstance.sendInput = mock()`.
- Dispatch `keydown` on the hidden textarea via `fireEvent.keyDown(textarea, { key, code, keyCode, shiftKey, ctrlKey, altKey, metaKey })`.
- Assert `mockInstance.sendInput.mock.calls[0][0] === expectedBytes`.
- One `describe` group per key family (Tab, Arrows, Backspace, Enter, Escape, Delete/Home/End, PageUp/Down, F-keys, Alt+letter, Ctrl+special). Matrix expansion via `it.each` where appropriate.
- Boundary cases: IME-in-progress guard (composition + keydown → no send); Meta+Arrow (no send); Shift+Enter deliberate divergence (still `\n`, guarded by an explicit test); Ctrl+letter tightening (`Ctrl+Shift+A` still emits `\x01` today; document expected new behaviour).
- TDD polarity: every new assertion must fail against the pre-fix handler and pass against the post-fix handler. `git stash --patch` the handler diff, run tests → all new assertions red. Restore diff → all green. (workflow.md "TDD for bug fixes".)
- Coverage target: ~40-50 new `it` blocks (rough estimate: 12 Critical rows × ~2 assertions each + 15 Recommended rows × ~1 each + IME/divergence guards).

## 7. Verification plan (real-device)

Dev instance (either `bun run dev` or Docker dev stack). For each TUI, drive the specific broken shortcut and confirm it now behaves per xterm/legacy `Terminal.tsx`.

| TUI | Shortcut | Expected behaviour |
|---|---|---|
| Claude Code | Shift+Tab | Cycles default → auto-accept → plan mode (visible in the status bar). |
| Claude Code | Alt+Backspace | Deletes the last word of the prompt buffer. |
| Claude Code | Shift+Enter | Inserts a soft newline (regression guard for the deliberate divergence). |
| vim | `<S-Tab>` in insert mode | Inserts the mapped completion or default backtab behaviour. |
| vim | `<S-Right>` in visual mode | Extends selection by a full word to the right (via `\x1b[1;2C`). |
| vim | `<C-Right>` / `<C-Left>` in insert mode | Moves cursor by word. |
| vim | `<Home>` / `<End>` / `<Delete>` | Cursor to line start/end, forward-delete. |
| vim | `<F1>` | Opens the built-in help window. |
| bash (readline) | Alt+B / Alt+F | Cursor by word backward / forward. |
| bash (readline) | Alt+D | `kill-word` (deletes word forward from cursor). |
| bash (readline) | Alt+. | `yank-last-arg` (inserts the last argument of the previous command). |
| bash (readline) | Ctrl+Left / Ctrl+Right | Same word-motion as Alt+B / Alt+F. |
| bash (readline) | Ctrl+Space | Sets mark (verified by killing region with subsequent `Ctrl+W`). |
| less | Home / End / PageUp / PageDown | Jump to top / bottom / paginate. |
| less | Shift+Tab (`<S-Tab>` in `--incsearch` mode) | Reverse-search completion (if configured). |
| tmux copy-mode | Shift+ArrowUp/Down | Extend selection. |
| tmux copy-mode | Ctrl+Left/Right | Word-motion. |
| htop | F1-F10 | Trigger the corresponding menu action. |
| midnight commander | F5 / F6 / F8 | Copy / Move / Delete. |

Screenshots (or animated GIF where key sequencing matters) will be attached to the PR body per `workflow.md` "Manual verification (UI changes only)" and "Gated / conditional UI true-path requirement" rules. When a shortcut effect is a status-bar toggle (Claude Code) or terminal-buffer contents diff, a before/after screenshot is sufficient; when it is a cursor move (arrow keys), the screenshot must show a distinct cursor position.

## 8. Roadmap note

`docs/design/labs-terminal-poc-roadmap.md` PR-2 "Input and interaction" inventory currently marks "Keyboard input" as `covered` based on the presence of the hidden-textarea + keydown handler in the legacy `Terminal.tsx`. The inventory method was **grep the legacy source**, which does not surface the built-in xterm.js conversion table (Shift+Tab, modifier-encoded arrows, F-keys, Alt+letter, etc.) because those never appeared in `Terminal.tsx` source — xterm.js absorbed them silently.

Phase B / Phase C will annotate that row with a "structural gap: parity inventory relied on legacy source grep and missed xterm.js built-ins; supplemented by [`docs/audits/terminal-key-handling-parity.md`](../audits/terminal-key-handling-parity.md) (Issue #985)". The sprint retro seed is: **promotion-parity audits must reference the upstream library, not only the local wrapper**.

## 9. Mobile SoftKeyBar (informational)

The `SoftKeyBar` (mobile) currently exposes `Esc`, `Tab`, `Ctrl+C`, four arrows, `Enter`. It is a **byte-preset bar** (each button sends a fixed byte sequence via `onKey`) — it bypasses `handleKeyDown` entirely and is unaffected by the gaps above. Adding a Shift+Tab button (`onKey('\x1b[Z')`) is a one-line change; whether to add it (and other modifier presets like Alt+B, PageUp/Down) is an owner UX call, not a parity concern. Deferred to owner judgement; Phase B does not modify `SoftKeyBar` unless explicitly directed.
