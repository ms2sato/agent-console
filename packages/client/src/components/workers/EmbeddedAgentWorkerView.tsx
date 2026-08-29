import { useRef, useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { Element as HastElement, Text as HastText } from 'hast';
import type { JSX } from 'react';
import type { ExtraProps } from 'react-markdown';
import { DEFAULT_COMPACTION_THRESHOLD } from '@agent-console/shared';
import type { PtyNotificationKind, EmbeddedAgentServerNotification } from '@agent-console/shared';
import { useEmbeddedAgentWorker } from './hooks/useEmbeddedAgentWorker';
import type { EmbeddedAgentChatEntry } from './embedded-agent-store';
import { RefreshIcon, AlertCircleIcon, CopyIcon, CheckIcon } from '../Icons';
import { MessagePanel } from '../sessions/MessagePanel';
import type { ConnectionStatus } from '../terminal/terminal-contract';
import { PreviewPanel } from './PreviewPanel';
import { ContextUsageBar } from './ContextUsageBar';
import { useEmbeddedAgents } from '../../hooks/useEmbeddedAgents';
import { logger } from '../../lib/logger';
import { updateEmbeddedAgentWorker } from '../../lib/api';
import { copyToClipboard } from '../../lib/clipboard';

/** Entries folded into the collapsed-by-default "Working" accordion. */
type GroupableEntry = Extract<EmbeddedAgentChatEntry, { kind: 'assistant-thinking' | 'tool-call' }>;
/** Entries that always render as top-level transcript rows. */
type OutsideEntry = Exclude<EmbeddedAgentChatEntry, { kind: 'assistant-thinking' | 'tool-call' }>;

interface WorkingGroup {
  /** turnId of this run's entries, used only to detect a turn boundary while extending the run. */
  turnId: string;
  entries: GroupableEntry[];
}

type DisplayItem =
  | { kind: 'entry'; entry: OutsideEntry }
  | { kind: 'working-group'; group: WorkingGroup };

function isGroupable(entry: EmbeddedAgentChatEntry): entry is GroupableEntry {
  return entry.kind === 'assistant-thinking' || entry.kind === 'tool-call';
}

/**
 * A finalized assistant-message with no text is an iteration that only
 * emitted tool calls -- there is nothing to show, so it must not render as
 * an empty chat bubble. A still-streaming empty assistant-message is kept:
 * it is the container the typing-cursor pulse renders inside while text is
 * still arriving, so suppressing it would hide the in-progress indicator.
 */
function isSuppressedEmptyAssistantMessage(entry: EmbeddedAgentChatEntry): boolean {
  return entry.kind === 'assistant-message' && !entry.streaming && entry.text.trim() === '';
}

/**
 * Derived view: two passes over entries.
 *
 * 1. Suppress finalized-empty assistant-message entries (see
 *    isSuppressedEmptyAssistantMessage) -- they carry no content and must
 *    not fragment the grouping below.
 * 2. Walk the reduced list once, coalescing RUNS of consecutive groupable
 *    (assistant-thinking / tool-call) entries into one WorkingGroup each. A
 *    run closes as soon as a non-groupable entry appears or the turnId
 *    changes between consecutive groupable entries; the next groupable
 *    entry starts a new run. A single turn therefore produces one Working
 *    block per tool-use iteration, not one block for the whole turn -- an
 *    intermediate assistant-message between two rounds of tool activity
 *    closes the first run and starts a second one, and both render at their
 *    chronological position, unchanged from the raw entries order.
 *
 * Suppression must run before grouping: if a finalized-empty
 * assistant-message was the only thing separating two groupable runs, its
 * removal makes those runs directly adjacent, and they must merge into a
 * single Working block -- the empty message was never meaningful content,
 * so it should never have fragmented the grouping.
 */
function buildDisplayItems(entries: EmbeddedAgentChatEntry[]): DisplayItem[] {
  const reduced = entries.filter((entry) => !isSuppressedEmptyAssistantMessage(entry));

  const items: DisplayItem[] = [];
  let openGroup: WorkingGroup | null = null;
  for (const entry of reduced) {
    if (isGroupable(entry)) {
      if (openGroup && openGroup.turnId === entry.turnId) {
        openGroup.entries.push(entry);
      } else {
        openGroup = { turnId: entry.turnId, entries: [entry] };
        items.push({ kind: 'working-group', group: openGroup });
      }
      continue;
    }
    openGroup = null;
    items.push({ kind: 'entry', entry });
  }
  return items;
}

interface EmbeddedAgentWorkerViewProps {
  sessionId: string;
  workerId: string;
  /** `EmbeddedAgentWorker.embeddedAgentId` -- looked up against the embedded-agent registry (`useEmbeddedAgents`) for `contextWindowTokens`/`compaction`. Undefined only defensively (every embedded-agent worker carries one). */
  embeddedAgentId?: string;
  /**
   * `EmbeddedAgentWorker.autoCompaction` -- the toggle's SERVER value, which
   * is what the control renders. Deliberately a prop rather than local state:
   * the server broadcasts the change back as a session update, so the client
   * follows it instead of holding its own opinion. Undefined only
   * defensively (every embedded-agent worker carries one).
   */
  autoCompaction?: boolean;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export function EmbeddedAgentWorkerView({
  sessionId,
  workerId,
  embeddedAgentId,
  autoCompaction,
  onStatusChange,
}: EmbeddedAgentWorkerViewProps) {
  const {
    status,
    entries,
    activityState,
    workerError,
    contextUsage,
    restoring,
    restoredMessageCount,
    sdkResumed,
    sendUserMessage,
    cancel,
    restart,
    retry,
    dismissError,
  } = useEmbeddedAgentWorker({ sessionId, workerId });

  const { embeddedAgents } = useEmbeddedAgents();
  const embeddedAgentDefinition = useMemo(
    () => embeddedAgents.find((a) => a.id === embeddedAgentId),
    [embeddedAgents, embeddedAgentId],
  );
  const contextWindowTokens = embeddedAgentDefinition?.contextWindowTokens;
  const compactionThreshold =
    embeddedAgentDefinition?.compaction?.threshold ?? DEFAULT_COMPACTION_THRESHOLD;

  // The toggle writes through REST and then follows the server's value
  // (which arrives as a session-updated broadcast). This flag only disables
  // the control while a write is in flight, so a double-click cannot queue a
  // second PATCH; it deliberately does NOT hold an optimistic value, which
  // would show a state the server may have rejected.
  const [togglePending, setTogglePending] = useState(false);
  const handleAutoCompactionChange = async (enabled: boolean): Promise<void> => {
    setTogglePending(true);
    try {
      await updateEmbeddedAgentWorker(sessionId, workerId, { autoCompaction: enabled });
    } catch (err) {
      logger.error('Failed to update auto-compaction', err);
    } finally {
      setTogglePending(false);
    }
  };

  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest entry. Component-scoped DOM interaction is an
  // accepted useEffect use per frontend.md ("Avoid useEffect" table).
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  // Bridge the store's connection status up to the parent's shared status
  // bar, mirroring TerminalAdapter's StatusCallbackBridge pattern -- the
  // status lives in an external store, so a parent notification is a
  // component-scoped side effect, not derivable state.
  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  const isTurnActive = activityState === 'active';

  // `claude-sdk` engine workers restore their live SDK session by resuming
  // it (R1, see docs/design/embedded-agent-sdk-engine.md §4.3), not by being
  // handed the reconstruction the generic banner below describes -- so that
  // banner is still only accurate for `openai-api` engine workers. `engine` is
  // genuinely three-valued here ('openai-api' / 'claude-sdk' / unresolved),
  // where "unresolved" covers both the registry still loading and a
  // dangling/unmatched embeddedAgentId -- so the generic banner uses an
  // explicit positive `=== 'openai-api'` check rather than `!isSdkEngine`.
  // Negating a two-valued check collapses "confirmed openai-api" and
  // "unresolved" into the same branch, which would show the openai-api-only
  // claim while the engine is still unknown.
  const isSdkEngine = embeddedAgentDefinition?.engine === 'claude-sdk';
  const isOpenaiApiEngine = embeddedAgentDefinition?.engine === 'openai-api';
  // `restoredMessageCount` is not reset to null when `restoring` flips
  // false (see its doc comment in embedded-agent-store.ts), so this is a
  // reliable "this activation/incarnation restored a non-empty prior
  // transcript" signal, decoupled from the transient restoring state.
  const hadPriorTranscriptThisIncarnation =
    restoredMessageCount !== null && restoredMessageCount > 0;
  // R1: `sdkResumed` is THREE-valued -- `undefined` means "this engine has
  // no such concept" (every `openai-api` worker, and a `claude-sdk` worker
  // before its first restore-info), `false` means "a resume was attempted or
  // intended and did not take". Only the latter may show the notice, so this
  // is an explicit `=== false`, never `!sdkResumed`: the negation would
  // collapse the two and put a permanent false warning on every
  // `openai-api` worker. Same trap as the engine discriminant above, which
  // is why both are written positively.
  const sdkResumeFailed = sdkResumed === false;

  const displayItems = useMemo(() => buildDisplayItems(entries), [entries]);

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-slate-900">
      <div className="px-4 py-2 bg-slate-800/60 border-b border-slate-700 text-gray-400 text-xs shrink-0">
        This is an experimental Embedded Agent.
      </div>

      {/* Persistent, non-dismissable transcript-restore notice (Transcript
          Restore #1123). This is a permanent fixture of the view, not a
          toast -- it has no close button. Only accurate for `openai-api`
          engine workers, whose live conversation IS reconstructed from the
          persisted transcript on revival -- gated on the confirmed
          `=== 'openai-api'` check, not `!isSdkEngine`, so it makes no claim
          while the engine is still unresolved (registry loading, or a
          dangling/unmatched embeddedAgentId). */}
      {isOpenaiApiEngine && (
        <div className="px-4 py-2 bg-amber-900/20 border-b border-amber-700/40 text-amber-200 text-xs shrink-0">
          Conversation is restored automatically after a worker or server restart; it only resets if the
          saved transcript can't be recovered.
        </div>
      )}

      {/* SDK-engine restore-divergence notice. POLARITY INVERTED BY R1
          (#1410): this was shown on EVERY `claude-sdk` restore, as a standing
          confession that the live session started fresh. R1 resumes the
          session, so a successful restore now shows nothing -- the
          conversation genuinely did continue -- and this survives only as the
          fallback confession, for the case where a resume was attempted and
          did not take. Porting the old unconditional rule forward would put a
          permanent false warning on every successful resume; see
          docs/design/embedded-agent-sdk-engine.md §4.3's polarity table and
          its correction trail. The wording states what is true and promises
          no recovery -- the same prohibition the compaction marker carries. */}
      {isSdkEngine && hadPriorTranscriptThisIncarnation && sdkResumeFailed && (
        <div className="px-4 py-2 bg-amber-900/20 border-b border-amber-700/40 text-amber-200 text-xs shrink-0">
          This worker's earlier conversation could not be carried over — the messages above are a
          record of what was said, not something the agent currently remembers. This turn starts fresh.
        </div>
      )}

      {workerError && (
        <div
          role="alert"
          className="px-4 py-2 bg-red-900/30 border-b border-red-700/50 text-red-200 text-sm shrink-0 flex items-center justify-between gap-3"
        >
          <span className="flex items-center gap-2">
            <AlertCircleIcon className="w-4 h-4 shrink-0" />
            {workerError.message}
          </span>
          {workerError.code === 'ACTIVATION_FAILED' ? (
            <button onClick={retry} className="btn btn-primary text-xs shrink-0">
              Retry
            </button>
          ) : (
            <button onClick={dismissError} className="text-red-300 hover:text-white text-xs shrink-0">
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Transient loading indicator (#1123/#1205). Wording is deliberately
          engine-neutral -- must not use "conversation"/"restoring" or any
          other memory-continuity word, since this same string renders for
          both openai-api (whose live session really is reconstructed, see
          the generic banner above) and claude-sdk (whose live session is
          NOT reconstructed, see the divergence notice above) workers. This
          block only reports that prior transcript content is loading into
          the display, not a claim about session continuity -- no per-engine
          branch here, on purpose: see EmbeddedAgentWorkerView.test.tsx's
          "SDK-engine restore-divergence notice" suite for the reasoning. */}
      {restoring && restoredMessageCount !== null && (
        <div className="px-4 py-2 bg-slate-800/60 border-b border-slate-700 text-gray-400 text-xs shrink-0 flex items-center gap-2">
          <span
            className="inline-block w-1.5 h-3 bg-gray-500 animate-pulse align-middle"
            aria-hidden="true"
          />
          Loading {restoredMessageCount} previous message
          {restoredMessageCount === 1 ? '' : 's'}...
        </div>
      )}

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {entries.length === 0 && (
          <div className="text-gray-500 text-sm">No messages yet. Say hello to get started.</div>
        )}
        {displayItems.map((item) =>
          item.kind === 'working-group' ? (
            <WorkingAccordion key={item.group.entries[0].key} group={item.group} />
          ) : (
            <ChatEntryRow key={item.entry.key} entry={item.entry} onRestart={restart} />
          ),
        )}
      </div>

      {/* Compaction chrome: the usage bar and the auto-compaction toggle --
          siblings inserted between the transcript and MessagePanel, never
          inside MessagePanel (shared with PTY workers, stays
          worker-type-agnostic). See docs/design/embedded-agent-worker.md
          "Compaction" § UI.

          The soft/hard threshold banners that used to live here are gone
          with the manual-handoff CTA they existed to point at: automatic
          compaction is the toggle below, and manual compaction is a request
          made to the agent in the message box. */}
      <ContextUsageBar
        contextWindowTokens={contextWindowTokens}
        contextUsage={contextUsage}
        threshold={compactionThreshold}
      />

      {/* The wording never names an engine or a mechanism (§3.1's no-leak
          principle): from here it is one feature, however differently the
          two engines implement it.

          `checked` is the server's value and nothing else. The client
          deliberately does NOT substitute the ON default when the value is
          unknown: that default is the server's (`workers.auto_compaction NOT
          NULL DEFAULT 1`), and re-implementing it here would give one fact
          two sources -- so a field that went missing at the wire would render
          as a confident ON and look completely normal. That is the exact
          failure shape Gap-Scan Q10 exists for, and this PR already hit one
          instance of it at a different gate.

          An unknown value therefore disables the control rather than
          displaying a guess, which also stops a click from PATCHing a value
          derived from one. */}
      <label className="px-4 py-1.5 shrink-0 flex items-center gap-2 text-xs text-gray-400 border-t border-slate-800">
        <input
          type="checkbox"
          checked={autoCompaction === true}
          disabled={togglePending || autoCompaction === undefined}
          onChange={(e) => void handleAutoCompactionChange(e.target.checked)}
          className="accent-blue-600 disabled:opacity-50"
        />
        <span>Compact automatically when the context fills up</span>
      </label>

      <MessagePanel
        sessionId={sessionId}
        targetWorkerId={workerId}
        newMessage={null}
        onSend={async (content) => {
          await sendUserMessage(content);
        }}
        onEscape={cancel}
        slashCompletionEnabled={false}
        attachmentsEnabled={false}
        cancelState={{ active: isTurnActive, onCancel: cancel }}
      />
    </div>
  );
}

/**
 * Compact a token count for the boundary marker: `102150` -> `102k`,
 * `2710` -> `2.7k`, `950` -> `950`. Rounded, because the marker's job is to
 * convey magnitude at a glance, not to be arithmetic.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  return thousands < 10 ? `${Math.round(thousands * 10) / 10}k` : `${Math.round(thousands)}k`;
}

/**
 * The boundary marker's line.
 *
 * Deliberately a STATEMENT OF FACT, never a promise. "Context compacted
 * (102k -> 2.7k)" reports what happened; anything of the form "your history
 * is preserved" would be a guarantee, and SDK-side compaction fidelity has
 * been measured non-deterministic (see docs/design/embedded-agent-worker.md
 * § Compaction, "Summary fidelity") -- a single counterexample would make
 * such a line a lie. The numbers are the point: a startlingly aggressive
 * compaction reports its own severity to the user.
 *
 * Falls back to the bare marker when the engine supplied no figures, rather
 * than printing a fabricated or zeroed one.
 */
export function formatCompactionBoundaryLabel(
  preTokens: number | undefined,
  postTokens: number | undefined,
): string {
  if (preTokens === undefined || postTokens === undefined) return '— Context compacted —';
  return `— Context compacted (${formatTokenCount(preTokens)} → ${formatTokenCount(postTokens)}) —`;
}

/**
 * Fenced-code-block languages that get a Preview toggle. Matched
 * case-insensitively against the `language-*` className react-markdown/
 * rehype-sanitize places on a fenced block's `<code>` element (e.g. an LLM
 * writing ` ```SVG ` still gets a preview).
 */
const PREVIEWABLE_LANG_PATTERN = /^language-(html|svg)$/i;

/** Returns the single `<code>` hast child of a `<pre>` node, or null if absent (defensive -- should always be present for a fenced block). */
function findCodeChild(node: HastElement | undefined): HastElement | null {
  if (!node) return null;
  const child = node.children.find(
    (c): c is HastElement => c.type === 'element' && c.tagName === 'code',
  );
  return child ?? null;
}

/** Reads the `code` node's `className` and matches it against PREVIEWABLE_LANG_PATTERN. Returns null for inline spans/unrelated languages -- those must render unchanged. */
function detectPreviewLang(codeNode: HastElement): 'html' | 'svg' | null {
  const rawClassName = codeNode.properties?.className;
  const classNames = Array.isArray(rawClassName) ? rawClassName.map(String) : [];
  for (const className of classNames) {
    const match = PREVIEWABLE_LANG_PATTERN.exec(className);
    if (match) return match[1].toLowerCase() as 'html' | 'svg';
  }
  return null;
}

/** Concatenates the text content of a hast node's descendant text nodes, depth-first. */
function extractText(node: HastElement): string {
  return node.children
    .map((child) => {
      if (child.type === 'text') return (child as HastText).value;
      if (child.type === 'element') return extractText(child as HastElement);
      return '';
    })
    .join('');
}

/**
 * Custom `pre` renderer for the finalized-assistant-message Markdown
 * pipeline. react-markdown passes the underlying hast `Element` via
 * `node` (passNode: true), which is used directly to detect a
 * html/svg-language fenced block and extract its raw text -- rather than
 * also overriding `code` and inspecting its rendered React children/props.
 * This keeps the default `code`/inline-code rendering completely untouched
 * (inline `code` spans never reach this component at all, since only a
 * fenced block's wrapping `<pre>` does), and confines all preview-detection
 * logic to a single override.
 *
 * On a match, renders the normal `<pre>` block exactly as before, plus a
 * `PreviewPanel` as a sibling immediately below it (never nested inside
 * `<pre>`/`<code>`).
 */
function PreviewablePre(props: JSX.IntrinsicElements['pre'] & ExtraProps) {
  const { node, children, ...rest } = props;
  const codeNode = findCodeChild(node);
  const lang = codeNode ? detectPreviewLang(codeNode) : null;

  if (!codeNode || lang === null) {
    return <pre {...rest}>{children}</pre>;
  }

  return (
    <>
      <pre {...rest}>{children}</pre>
      <PreviewPanel code={extractText(codeNode)} lang={lang} />
    </>
  );
}

/** How long the Check-icon/"Copied!" feedback state holds before reverting to the idle Copy icon (#1118). */
const COPY_MARKDOWN_FEEDBACK_MS = 1500;

/**
 * Icon-only button pinned to the bottom-right of an assistant message
 * bubble. Copies the message's raw markdown SOURCE (the `text` prop, as
 * received from the agent) to the clipboard -- never the rendered HTML the
 * Markdown pipeline produces. On click, swaps to a Check icon and a
 * "Copied!" tooltip for COPY_MARKDOWN_FEEDBACK_MS before reverting.
 */
function CopyMarkdownButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const revertTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (revertTimeoutRef.current !== null) clearTimeout(revertTimeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await copyToClipboard(text);
    } catch (err) {
      logger.error('Failed to copy markdown:', err);
      return;
    }

    setCopied(true);
    if (revertTimeoutRef.current !== null) clearTimeout(revertTimeoutRef.current);
    revertTimeoutRef.current = setTimeout(() => setCopied(false), COPY_MARKDOWN_FEEDBACK_MS);
  };

  const label = copied ? 'Copied!' : 'Copy as markdown';

  return (
    <button
      onClick={handleCopy}
      title={label}
      aria-label={label}
      className="text-gray-500 hover:text-gray-200 p-1 rounded hover:bg-slate-700 shrink-0"
    >
      {copied ? <CheckIcon className="w-3.5 h-3.5" /> : <CopyIcon className="w-3.5 h-3.5" />}
    </button>
  );
}

/**
 * Humanized labels for every {@link PtyNotificationKind}.
 * `satisfies Record<PtyNotificationKind, string>` makes a future addition to
 * the shared enum a compile error here until a label is added -- see
 * design-principles.md "Enforce constraints through structure, not
 * convention".
 */
const NOTIFICATION_KIND_LABELS = {
  'inbound-event': 'Inbound Event',
  'internal-message': 'Message',
  'internal-timer': 'Timer',
  'internal-review-comment': 'Review Comment',
  'internal-reviewed': 'Review Completed',
  'internal-process': 'Process',
  'internal-conditional-wakeup': 'Conditional Wakeup',
  'internal-agent-spawn-failed': 'Agent Spawn Failed',
} satisfies Record<PtyNotificationKind, string>;

/** Cap (in characters) for the fallback preview derived from a notification's raw text -- see notificationPreviewText. */
const NOTIFICATION_PREVIEW_CAP = 140;

/**
 * Collapsed-row preview text for a notification entry: the `summary` field
 * when the notification's kind carries one (`internal-message`/
 * `inbound-event`), otherwise a capped first line of the raw text --
 * `buildPtyNotificationText` (server) always embeds `timestamp=<ISO8601>` as
 * the first field, so this fallback already surfaces a timestamp without any
 * separate date-parsing logic here.
 */
function notificationPreviewText(entry: { text: string; notification: EmbeddedAgentServerNotification }): string {
  if (entry.notification.summary !== undefined) return entry.notification.summary;
  const firstLine = entry.text.trim().split('\n')[0] ?? '';
  return firstLine.length > NOTIFICATION_PREVIEW_CAP
    ? `${firstLine.slice(0, NOTIFICATION_PREVIEW_CAP)}…`
    : firstLine;
}

type NotificationEntry = Extract<EmbeddedAgentChatEntry, { kind: 'user-message' }> & {
  notification: EmbeddedAgentServerNotification;
};

/**
 * Muted, full-width, collapsed-by-default row for a system-originated
 * internal notification delivered as a `user-message` -- visually distinct
 * from both the user-bubble (`bg-blue-600/80`) and the
 * assistant-message (`bg-slate-800`) treatments. Raw text renders as a plain
 * text node (never through the Markdown pipeline) since it is operational
 * metadata, not agent prose.
 */
function NotificationRow({ entry }: { entry: NotificationEntry }) {
  const label = NOTIFICATION_KIND_LABELS[entry.notification.kind];
  return (
    <div className="text-sm text-gray-500 bg-slate-800/40 border border-slate-700/60 rounded px-3 py-2">
      <details>
        <summary className="cursor-pointer flex items-center gap-2 text-xs text-gray-400">
          <span className="uppercase tracking-wide text-[10px] text-gray-600 shrink-0">{label}</span>
          <span className="truncate">{notificationPreviewText(entry)}</span>
        </summary>
        <div className="mt-2 min-w-0 whitespace-pre-wrap text-xs text-gray-400 font-mono [overflow-wrap:anywhere]">
          {entry.text}
        </div>
      </details>
    </div>
  );
}

interface ChatEntryRowProps {
  entry: OutsideEntry;
  onRestart: () => void;
}

function ChatEntryRow({ entry, onRestart }: ChatEntryRowProps) {
  switch (entry.kind) {
    case 'user-message':
      if (entry.notification) {
        return <NotificationRow entry={entry as NotificationEntry} />;
      }
      return (
        <div className="flex justify-end">
          <div className="min-w-0 max-w-[80%] rounded-lg bg-blue-600/80 text-white px-3 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
            {entry.text}
          </div>
        </div>
      );
    case 'assistant-message':
      return (
        <div className="flex justify-start">
          <div className="memo-content min-w-0 rounded-lg bg-slate-800 text-gray-100 px-3 py-2 text-sm">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              // Preview toggle activation is gated on finalized content only:
              // a still-streaming message may contain an unclosed fence, and
              // previewing partial/unsanitized-looking markup mid-stream is
              // out of scope. `components: undefined` is identical to the
              // pre-preview-toggle render for streaming entries.
              components={!entry.streaming ? { pre: PreviewablePre } : undefined}
            >
              {entry.text}
            </Markdown>
            {entry.streaming && <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-gray-400 animate-pulse align-middle" aria-hidden="true" />}
            {!entry.streaming && (
              <div className="flex justify-end mt-1">
                <CopyMarkdownButton text={entry.text} />
              </div>
            )}
          </div>
        </div>
      );
    case 'turn-error':
      return (
        <div className="text-sm text-red-400 bg-red-950/40 border border-red-800/50 rounded px-3 py-2">
          Turn error: {entry.message}
        </div>
      );
    case 'fatal':
      return (
        <div className="text-sm text-red-300 bg-red-950/60 border border-red-700 rounded px-3 py-2 font-medium">
          Fatal: {entry.message}
        </div>
      );
    case 'exited':
      return (
        <div className="flex items-center gap-3 text-sm text-gray-400 bg-slate-800/60 rounded px-3 py-2">
          <span>Agent process exited{entry.code !== null ? ` (code: ${entry.code})` : ''}.</span>
          <button
            onClick={onRestart}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-gray-200"
          >
            <RefreshIcon className="w-3.5 h-3.5" />
            Restart
          </button>
        </div>
      );
    case 'context-compacted': {
      // "One line marking the compaction boundary appears in the
      // transcript." A summary, when the engine produced one, hangs off it
      // as a disclosure rather than expanding the line.
      const label = formatCompactionBoundaryLabel(entry.preTokens, entry.postTokens);
      return (
        <div className="text-sm text-gray-400 bg-slate-800/60 border border-slate-700 rounded px-3 py-2">
          {entry.summary !== undefined ? (
            <details>
              <summary className="cursor-pointer text-xs text-gray-400">{label}</summary>
              <div className="mt-2 min-w-0 whitespace-pre-wrap text-xs text-gray-300 [overflow-wrap:anywhere]">
                {entry.summary}
              </div>
            </details>
          ) : (
            <div className="text-xs text-gray-400">{label}</div>
          )}
        </div>
      );
    }
    case 'context-handoff':
      // LEGACY (#1401): no engine emits this any more, but a transcript
      // written before the compaction swap replays these rows on every
      // history load. Removing this case would render an old transcript with
      // a silent hole where a real boundary was, so it stays -- regression-
      // locked by a historical-stream fixture in the sibling test.
      return (
        <div className="text-sm text-gray-400 bg-slate-800/60 border border-slate-700 rounded px-3 py-2">
          <details>
            <summary className="cursor-pointer text-xs text-gray-400">
              — Context handoff: conversation restarted from summary —
            </summary>
            <div className="mt-2 min-w-0 whitespace-pre-wrap text-xs text-gray-300 [overflow-wrap:anywhere]">
              {entry.distillation}
            </div>
          </details>
        </div>
      );
    case 'turn-interrupted':
      // R1: the process went away before this turn was answered. A distinct
      // row from `turn-error` on purpose -- nothing reported an error, so
      // this is styled as a neutral marker rather than a failure, and its
      // wording says only what the server observed.
      return (
        <div className="text-sm text-gray-400 bg-slate-800/60 border border-slate-700 rounded px-3 py-2 text-xs">
          — This turn was interrupted before it finished, and was not answered —
        </div>
      );
    case 'restore-repair':
      return (
        <div className="text-sm text-gray-400 bg-slate-800/60 border border-slate-700 rounded px-3 py-2">
          <details>
            <summary className="cursor-pointer text-xs text-gray-400">
              — Some tool calls were interrupted by a restart and marked as errors —
            </summary>
            <div className="mt-2 min-w-0 text-xs text-gray-300">
              {entry.toolCallIds.length} tool call{entry.toolCallIds.length === 1 ? '' : 's'} affected.
            </div>
          </details>
        </div>
      );
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

type ThinkingEntry = Extract<EmbeddedAgentChatEntry, { kind: 'assistant-thinking' }>;

/**
 * Inline (non-collapsible) block for streamed thinking/reasoning text,
 * rendered directly inside the WorkingAccordion body. Previously this was
 * its own nested <details>/<summary> accordion, requiring a second click
 * after opening Working -- flattened per #1119 (owner: the extra nesting
 * level served no purpose Thinking specifically needed, unlike ToolCallCard
 * below, which keeps its own accordion since individual tool calls are
 * still meaningfully toggled one at a time). Body renders as plain text
 * (NOT through the Markdown pipeline -- out of scope per #1070) with the
 * same overflow-wrap treatment as the Markdown message bubbles (#1071),
 * since thinking narrative can also contain long unbroken tokens (e.g.
 * quoted file contents).
 *
 * Only invoked from inside WorkingAccordion, which already supplies the
 * chat-bubble positioning (flex justify-start / max-w-[80%]); this
 * component renders just its own card so the two don't double-nest. Opening
 * Working now directly reveals this block's content -- there is no
 * intermediate collapsed state of its own.
 */
function ThinkingBlock({ entry }: { entry: ThinkingEntry }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2 text-xs">
      <div className="text-gray-500 flex items-center gap-1.5">
        <span>Thinking</span>
        {entry.streaming && (
          <span className="inline-block w-1.5 h-3 bg-gray-500 animate-pulse align-middle" aria-hidden="true" />
        )}
      </div>
      <div className="mt-2 min-w-0 whitespace-pre-wrap text-gray-500 [overflow-wrap:anywhere]">
        {entry.text}
      </div>
    </div>
  );
}

type ToolCallEntry = Extract<EmbeddedAgentChatEntry, { kind: 'tool-call' }>;

function ToolCallCard({ entry }: { entry: ToolCallEntry }) {
  const hasResult = entry.result !== null;
  const isError = hasResult && entry.result?.ok === false;

  return (
    <div
      className={`text-sm rounded border px-3 py-2 ${
        isError ? 'bg-red-950/30 border-red-800/50' : 'bg-slate-800 border-slate-700'
      }`}
    >
      <details>
        <summary className="cursor-pointer text-gray-300 font-mono text-xs flex items-center gap-2">
          <span className="text-purple-400">tool</span>
          {entry.name}
          {!hasResult && <span className="text-gray-500">(running...)</span>}
        </summary>
        <pre className="mt-2 min-w-0 text-xs text-gray-400 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {JSON.stringify(entry.args, null, 2)}
        </pre>
      </details>
      {hasResult && (
        <div className={`mt-2 min-w-0 text-xs font-mono whitespace-pre-wrap [overflow-wrap:anywhere] ${isError ? 'text-red-300' : 'text-gray-400'}`}>
          {entry.result?.result}
        </div>
      )}
    </div>
  );
}

/**
 * Fixed label for the per-run "Working" accordion. A single named constant
 * so the label can be renamed later without touching render logic.
 */
const WORKING_LABEL = 'Working';

function formatWorkingSummary(group: WorkingGroup): string {
  const toolCallCount = group.entries.filter((e) => e.kind === 'tool-call').length;
  if (toolCallCount === 0) return WORKING_LABEL;
  return `${WORKING_LABEL} (${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'})`;
}

/**
 * Collapsed-by-default accordion that groups one consecutive run of
 * thinking/tool-call activity into a single row, keeping the chat surface a
 * clean transcript. A turn that iterates through several tool-use rounds
 * produces one of these per run, interleaved with any narration between
 * rounds -- not one accordion for the whole turn.
 *
 * Keyed at the call site by the run's FIRST entry's stable store-assigned
 * key (not `turnId`, which is no longer unique per run once a turn can
 * produce multiple runs) so React reuses the same DOM node across
 * re-renders as the run streams -- native <details open> state lives on the
 * DOM node, not React state, so a stable key is what keeps a user-expanded
 * accordion open while more entries are appended to the same run. The first
 * entry's key never changes while the run is open (new entries only ever
 * append to the run's tail), so it is stable for the run's whole lifetime.
 */
function WorkingAccordion({ group }: { group: WorkingGroup }) {
  const isStreaming = group.entries.some(
    (e) => (e.kind === 'assistant-thinking' && e.streaming) || (e.kind === 'tool-call' && e.result === null),
  );
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2 text-xs">
        <details>
          <summary className="cursor-pointer text-gray-500 flex items-center gap-1.5">
            <span>{formatWorkingSummary(group)}</span>
            {isStreaming && (
              <span className="inline-block w-1.5 h-3 bg-gray-500 animate-pulse align-middle" aria-hidden="true" />
            )}
          </summary>
          <div className="mt-2 space-y-2">
            {group.entries.map((entry) =>
              entry.kind === 'assistant-thinking' ? (
                <ThinkingBlock key={entry.key} entry={entry} />
              ) : (
                <ToolCallCard key={entry.key} entry={entry} />
              ),
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
