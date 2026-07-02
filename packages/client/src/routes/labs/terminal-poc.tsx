import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { fetchWorkers } from '../../lib/api';
import { getOrCreatePocTerminal } from '../../labs/terminal-poc/poc-terminal-store';
import { PocTerminalView } from '../../labs/terminal-poc/PocTerminalView';
import { PocKeyboardInput } from '../../labs/terminal-poc/PocKeyboardInput';
import { useVisualViewportHeight } from '../../labs/terminal-poc/useVisualViewportHeight';

interface TerminalPocSearch {
  sessionId?: string;
  workerId?: string;
}

export const Route = createFileRoute('/labs/terminal-poc')({
  validateSearch: (search: Record<string, unknown>): TerminalPocSearch => ({
    sessionId: typeof search.sessionId === 'string' ? search.sessionId : undefined,
    workerId: typeof search.workerId === 'string' ? search.workerId : undefined,
  }),
  component: TerminalPocRoute,
});

function TerminalPocRoute() {
  const { sessionId, workerId } = Route.useSearch();
  if (sessionId && workerId) {
    return <TerminalPocPage sessionId={sessionId} workerId={workerId} />;
  }
  return <TerminalPocPicker initialSessionId={sessionId} />;
}

function TerminalPocPage({ sessionId, workerId }: { sessionId: string; workerId: string }) {
  const vvh = useVisualViewportHeight();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Instance is keyed by sessionId:workerId and lives in the module store, so
  // this memo just fetches the live handle (never re-creates on re-render).
  const instance = useMemo(
    () => getOrCreatePocTerminal(sessionId, workerId),
    [sessionId, workerId],
  );

  const focusInput = () => inputRef.current?.focus();

  // Snapshot-free page: all live-state reads happen in subscribed children.
  return (
    <div
      className="fixed left-0 top-0 flex w-full flex-col bg-[#1a1a2e]"
      style={{ height: vvh || '100vh' }}
    >
      <header className="flex items-center justify-between border-b border-slate-700 bg-slate-900 px-3 py-2 text-white">
        <span className="text-sm font-medium">Terminal Renderer PoC (labs)</span>
        <span className="text-xs text-slate-400">{sessionId.slice(0, 8)} / {workerId.slice(0, 8)}</span>
      </header>

      <StatusLine instance={instance} />

      <LoadingHistoryBar instance={instance} />
      <NoticeBanner instance={instance} />
      <WorkerErrorStrip instance={instance} />

      <PocTerminalView instance={instance} onRequestFocus={focusInput} />

      <PocKeyboardInput ref={inputRef} instance={instance} />

      <ExitBanner instance={instance} />
    </div>
  );
}

function LoadingHistoryBar({ instance }: { instance: ReturnType<typeof getOrCreatePocTerminal> }) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  if (!snapshot.loadingHistory) return null;
  return (
    <div className="bg-blue-900/50 px-3 py-1 text-center text-xs text-blue-200 animate-pulse">
      Loading history…
    </div>
  );
}

function NoticeBanner({ instance }: { instance: ReturnType<typeof getOrCreatePocTerminal> }) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  if (!snapshot.notice) return null;
  return (
    <div className="flex items-center justify-between gap-2 bg-amber-900/60 px-3 py-1 text-xs text-amber-200">
      <span>{snapshot.notice}</span>
      <button
        type="button"
        onClick={() => instance.dismissNotice()}
        className="rounded bg-amber-700/60 px-2 py-0.5 hover:bg-amber-600/60"
      >
        Dismiss
      </button>
    </div>
  );
}

function WorkerErrorStrip({ instance }: { instance: ReturnType<typeof getOrCreatePocTerminal> }) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  if (!snapshot.workerError) return null;
  const { message, code } = snapshot.workerError;
  return (
    <div className="bg-red-900/70 px-3 py-1 text-xs text-red-200">
      {message}
      {code ? ` (${code})` : ''}
    </div>
  );
}

function StatusLine({ instance }: { instance: ReturnType<typeof getOrCreatePocTerminal> }) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  const color =
    snapshot.status === 'connected'
      ? 'text-green-400'
      : snapshot.status === 'exited'
        ? 'text-red-400'
        : 'text-yellow-400';
  return (
    <div className="flex items-center gap-3 bg-slate-800 px-3 py-1 text-xs text-slate-300">
      <span className={color}>● {snapshot.status}</span>
      <span>
        {snapshot.cols}×{snapshot.terminalRows}
      </span>
    </div>
  );
}

function ExitBanner({ instance }: { instance: ReturnType<typeof getOrCreatePocTerminal> }) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  if (snapshot.status !== 'exited' || !snapshot.exitInfo) return null;
  return (
    <div className="bg-red-900/60 px-3 py-1 text-center text-xs text-red-200">
      Process exited (code {snapshot.exitInfo.code}
      {snapshot.exitInfo.signal ? `, signal ${snapshot.exitInfo.signal}` : ''})
    </div>
  );
}

function TerminalPocPicker({ initialSessionId }: { initialSessionId?: string }) {
  const navigate = useNavigate();
  const [sessionInput, setSessionInput] = useState(initialSessionId ?? '');
  const [activeSessionId, setActiveSessionId] = useState(initialSessionId ?? '');

  const { data, isLoading, error } = useQuery({
    queryKey: ['poc-workers', activeSessionId],
    queryFn: () => fetchWorkers(activeSessionId),
    enabled: activeSessionId.length > 0,
  });

  return (
    <div className="mx-auto max-w-lg px-4 py-8 text-slate-200">
      <h1 className="mb-1 text-xl font-semibold">Terminal Renderer PoC (labs)</h1>
      <p className="mb-6 text-sm text-slate-400">
        Enter a session ID, then pick a worker to open the experimental renderer.
      </p>

      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setActiveSessionId(sessionInput.trim());
        }}
      >
        <input
          value={sessionInput}
          onChange={(e) => setSessionInput(e.target.value)}
          placeholder="sessionId"
          className="flex-1 rounded border border-slate-600 bg-slate-800 px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600">
          Load
        </button>
      </form>

      {isLoading && <div className="text-sm text-slate-400">Loading workers…</div>}
      {error && (
        <div className="text-sm text-red-400">
          {error instanceof Error ? error.message : 'Failed to load workers'}
        </div>
      )}

      {data && (
        <ul className="space-y-2">
          {data.workers.length === 0 && (
            <li className="text-sm text-slate-400">No workers in this session.</li>
          )}
          {data.workers.map((worker) => (
            <li key={worker.id}>
              <button
                type="button"
                onClick={() =>
                  navigate({
                    to: '/labs/terminal-poc',
                    search: { sessionId: activeSessionId, workerId: worker.id },
                  })
                }
                className="flex w-full items-center justify-between rounded border border-slate-700 bg-slate-800 px-3 py-2 text-left text-sm hover:bg-slate-700"
              >
                <span className="font-mono">{worker.id}</span>
                <span className="rounded bg-slate-700 px-2 py-0.5 text-xs capitalize">
                  {worker.type}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
