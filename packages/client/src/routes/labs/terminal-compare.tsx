import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { MemoizedTerminal } from '../../components/Terminal';
import { PocTerminalAdapter } from '../../labs/terminal-poc/PocTerminalAdapter';

interface TerminalCompareSearch {
  sessionId?: string;
  workerId?: string;
  stripScrollbackClear?: boolean;
}

export const Route = createFileRoute('/labs/terminal-compare')({
  validateSearch: (search: Record<string, unknown>): TerminalCompareSearch => ({
    sessionId: typeof search.sessionId === 'string' ? search.sessionId : undefined,
    workerId: typeof search.workerId === 'string' ? search.workerId : undefined,
    stripScrollbackClear: search.stripScrollbackClear === true || search.stripScrollbackClear === 'true',
  }),
  component: TerminalCompareRoute,
});

/**
 * Side-by-side parity harness: the production `MemoizedTerminal` (legacy) and the
 * PoC `PocTerminalAdapter` (next) both attach separate WebSocket connections to
 * the SAME worker, so a reviewer can compare rendering and recovery behavior on
 * live output. `stripScrollbackClear` is threaded to both for a fair comparison.
 */
function TerminalCompareRoute() {
  const { sessionId, workerId, stripScrollbackClear } = Route.useSearch();

  if (!sessionId || !workerId) {
    return (
      <div className="mx-auto max-w-lg px-4 py-8 text-slate-200">
        <h1 className="mb-1 text-xl font-semibold">Terminal Comparison (labs)</h1>
        <p className="text-sm text-slate-400">
          Provide <code className="rounded bg-slate-800 px-1">sessionId</code> and{' '}
          <code className="rounded bg-slate-800 px-1">workerId</code> search params, e.g.
          <code className="mt-2 block break-all rounded bg-slate-800 px-2 py-1 text-xs">
            /labs/terminal-compare?sessionId=SID&amp;workerId=WID&amp;stripScrollbackClear=true
          </code>
        </p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-black">
      <div className="shrink-0 border-b border-amber-800/60 bg-amber-950/70 px-3 py-1 text-center text-xs text-amber-200">
        Both panes share one PTY. The app renders for whichever pane resized last; the other may clip
        (tmux-style constraint). Use this page for visual parity review; for interaction testing use
        /labs/terminal-poc.
      </div>
      <ComparePane label="legacy (production Terminal.tsx)">
        <MemoizedTerminal
          sessionId={sessionId}
          workerId={workerId}
          stripScrollbackClear={stripScrollbackClear}
        />
      </ComparePane>
      <div className="h-px shrink-0 bg-slate-600" />
      <ComparePane label="next (PoC PocTerminalAdapter)">
        <PocTerminalAdapter
          sessionId={sessionId}
          workerId={workerId}
          stripScrollbackClear={stripScrollbackClear}
        />
      </ComparePane>
    </div>
  );
}

function ComparePane({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 bg-slate-800 px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-300">
        {label}
      </div>
      {/* Full flex-col chain down to the hosted terminal so xterm's fit sees a
          resolved height at mount (mirrors how SessionPage hosts Terminal). A
          bare relative wrapper leaves the production Terminal's flex-1 root with
          no flex parent -> fit races to rows=1 / 16px. */}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
