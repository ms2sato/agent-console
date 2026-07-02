/**
 * Guard against selection-destroying mouse-protocol re-assertion.
 *
 * Some TUIs (e.g. Claude Code's fullscreen UI) re-emit their DEC mouse
 * tracking setup (CSI ? 1000/1002/1003 h) on every redraw. xterm.js fires
 * onProtocolChange even when the value does not change, and the browser
 * terminal responds by disabling the selection service, which also CLEARS
 * the current selection. With such a CLI running, every redraw wipes the
 * user's selection, making copy effectively impossible.
 *
 * The guard intercepts single-parameter mouse-protocol DECSET sequences at
 * the parser level and swallows the ones that do NOT strictly upgrade the
 * protocol. The four protocols form a strict event-superset chain
 * (x10 < vt200 < drag < any), so:
 *   - a fresh activation (none -> vt200 -> drag -> any) passes through and
 *     reaches the intended final mode, and
 *   - a steady-state re-assert burst (already 'any'; each step is a
 *     downgrade or equal) is swallowed entirely -- no protocol churn, the
 *     selection survives.
 *
 * Deliberately NOT intercepted: DECRST (`l`, turning tracking off), multi-
 * parameter sequences, non-mouse parameters, and encoding params
 * (1005/1006/1015/1016 -- encoding changes do not fire onProtocolChange).
 * Known trade-off: an app that genuinely downgrades (e.g. any -> vt200)
 * without an intervening DECRST keeps the stronger mode and receives extra
 * motion reports it no longer wants; real-world TUIs toggle off/on instead.
 */
import type { IDisposable, Terminal } from '@xterm/xterm';

type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

export const MOUSE_PROTOCOL_RANK = {
  none: 0,
  x10: 1,
  vt200: 2,
  drag: 3,
  any: 4,
} as const;

/**
 * Maps a mouse-protocol DECSET parameter to the tracking mode it requests.
 * Only the four protocol-selecting params are listed; encoding params
 * (1005/1006/1015/1016) and non-mouse params are absent by design.
 */
const MOUSE_PARAM_TO_MODE: Record<number, MouseTrackingMode> = {
  9: 'x10',
  1000: 'vt200',
  1002: 'drag',
  1003: 'any',
};

/**
 * True iff a `CSI ? <param> h` request should be swallowed instead of applied.
 *
 * Swallowed when the param selects a mouse protocol (9/1000/1002/1003) AND
 * the requested protocol does not strictly upgrade the current mode
 * (rank(requested) <= rank(current)). All other params pass through.
 */
export function shouldSwallowMouseProtocolSet(
  param: number,
  currentMode: MouseTrackingMode,
): boolean {
  const requestedMode = MOUSE_PARAM_TO_MODE[param];
  if (requestedMode === undefined) return false;
  return MOUSE_PROTOCOL_RANK[requestedMode] <= MOUSE_PROTOCOL_RANK[currentMode];
}

/**
 * Install the guard on a terminal. Returns an IDisposable that removes the
 * parser handler (the guard holds no timers or other resources).
 */
export function installMouseProtocolGuard(terminal: Terminal): IDisposable {
  return terminal.parser.registerCsiHandler(
    { prefix: '?', final: 'h' },
    (params) => {
      if (params.length !== 1 || typeof params[0] !== 'number') return false;
      return shouldSwallowMouseProtocolSet(params[0], terminal.modes.mouseTrackingMode);
    },
  );
}
