import { useRef, useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { Element as HastElement, Text as HastText } from 'hast';
import type { JSX } from 'react';
import type { ExtraProps } from 'react-markdown';
import { useEmbeddedAgentWorker } from './hooks/useEmbeddedAgentWorker';
import type { EmbeddedAgentChatEntry } from './embedded-agent-store';
import { RefreshIcon, AlertCircleIcon, CopyIcon, CheckIcon } from '../Icons';
import { MessagePanel } from '../sessions/MessagePanel';
import type { ConnectionStatus } from '../terminal/terminal-contract';
import { PreviewPanel } from './PreviewPanel';
import { ContextUsageBar } from './ContextUsageBar';
import { crossedThreshold } from './context-usage-threshold';
import { useEmbeddedAgents } from '../../hooks/useEmbeddedAgents';
import { logger } from '../../lib/logger';

/** Defaults when `EmbeddedAgentDefinition.handoff.softRatio`/`hardRatio` are unset -- see docs/design/embedded-agent-worker.md "Context Handoff (Phase A)" § UI. */
const DEFAULT_SOFT_RATIO = 0.75;
const DEFAULT_HARD_RATIO = 0.9;

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
  /** `EmbeddedAgentWorker.embeddedAgentId` -- looked up against the embedded-agent registry (`useEmbeddedAgents`) for `contextWindowTokens`/`handoff` (Context Handoff Phase A). Undefined only defensively (every embedded-agent worker carries one). */
  embeddedAgentId?: string;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export function EmbeddedAgentWorkerView({
  sessionId,
  workerId,
  embeddedAgentId,
  onStatusChange,
}: EmbeddedAgentWorkerViewProps) {
  const {
    status,
    entries,
    activityState,
    workerError,
    contextUsage,
    handoffInFlight,
    sendUserMessage,
    cancel,
    restart,
    retry,
    dismissError,
    triggerHandoff,
  } = useEmbeddedAgentWorker({ sessionId, workerId });

  const { embeddedAgents } = useEmbeddedAgents();
  const embeddedAgentDefinition = useMemo(
    () => embeddedAgents.find((a) => a.id === embeddedAgentId),
    [embeddedAgents, embeddedAgentId],
  );
  const contextWindowTokens = embeddedAgentDefinition?.contextWindowTokens;
  const softRatio = embeddedAgentDefinition?.handoff?.softRatio ?? DEFAULT_SOFT_RATIO;
  const hardRatio = embeddedAgentDefinition?.handoff?.hardRatio ?? DEFAULT_HARD_RATIO;
  const ratio =
    contextWindowTokens !== undefined && contextUsage !== null
      ? contextUsage.promptTokens / contextWindowTokens
      : null;

  // Threshold-crossing tracking (Context Handoff Phase A): reacting to
  // `ratio` changing over time against the store's asynchronous, external
  // updates is a legitimate useEffect use case per frontend.md's own
  // carve-out ("Component-scoped ... browser API subscriptions") -- this is
  // the same shape as the store-status bridge effect below, not a case of
  // deriving state from current props during render. A plain render-phase
  // `if (...) setState(...)` comparison was tried first but proved
  // unreliable in a real browser: `contextUsage` arrives via a store
  // `patch()`/`notify()` outside React's render cycle, and interleaving that
  // external notification with a same-pass "adjust state during render"
  // write let a later, unrelated re-render (e.g. the `activityState` ->
  // `idle` update that follows moments later) observe the OLD `false` state
  // and clobber the crossing that had just been recorded -- confirmed via
  // live console tracing (banner state flips true -> false across two
  // consecutive renders with no dismiss click and no code path setting it
  // back to false). Root-caused to React.StrictMode's dev-mode double-invoke
  // of the render function (active for `bun run dev`, which is how this was
  // dogfooded) interacting with the render-phase `setState` + direct
  // `prevRatioRef` mutation: the ref (a plain mutable object) survives a
  // discarded/re-invoked render pass, but a pending `setSoftBannerShown(true)`
  // from that pass does not, so a later render sees "already past the
  // threshold" on the ref while `softBannerShown` is still stuck at its
  // pre-crossing value. `useEffect` avoids this because the ref advance and
  // the setState calls run together, atomically, after commit -- not subject
  // to StrictMode's render-phase double-invoke -- keyed only off `ratio`
  // actually changing. Regression-guarded in
  // EmbeddedAgentWorkerView.test.tsx's `renderViewStrict`-based tests (only
  // reproducible with `<StrictMode>` wrapping, matching main.tsx's app root).
  // See docs/design/embedded-agent-worker.md "Context Handoff (Phase A)" §
  // UI "Threshold banners".
  const prevRatioRef = useRef<number | null>(null);
  const [softBannerShown, setSoftBannerShown] = useState(false);
  const [hardBannerShown, setHardBannerShown] = useState(false);
  useEffect(() => {
    if (ratio === null) return;
    const prevRatio = prevRatioRef.current;
    if (ratio < softRatio) {
      setSoftBannerShown(false);
    } else if (crossedThreshold(prevRatio, ratio, softRatio)) {
      setSoftBannerShown(true);
    }
    if (ratio < hardRatio) {
      setHardBannerShown(false);
    } else if (crossedThreshold(prevRatio, ratio, hardRatio)) {
      setHardBannerShown(true);
    }
    prevRatioRef.current = ratio;
  }, [ratio, softRatio, hardRatio]);

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

  const displayItems = useMemo(() => buildDisplayItems(entries), [entries]);

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-slate-900">
      <div className="px-4 py-2 bg-slate-800/60 border-b border-slate-700 text-gray-400 text-xs shrink-0">
        This is an experimental Embedded Agent. Restart resets the conversation.
      </div>

      {/* Persistent, non-dismissable reset-on-restart notice. This is a
          permanent fixture of the view (v1 worker-type inconsistency called
          out in docs/design/embedded-agent-worker.md "Design Decisions"),
          not a toast -- it has no close button. */}
      <div className="px-4 py-2 bg-amber-900/20 border-b border-amber-700/40 text-amber-200 text-xs shrink-0">
        Conversation resets when this worker or the server restarts (no transcript persistence in v1).
      </div>

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

      {/* Context Handoff (Phase A) chrome: usage bar, threshold banners, and
          the always-reachable manual handoff CTA -- siblings inserted
          between the transcript and MessagePanel, never inside MessagePanel
          (shared with PTY workers, stays worker-type-agnostic). See
          docs/design/embedded-agent-worker.md "Context Handoff (Phase A)" §
          UI. */}
      <ContextUsageBar
        contextWindowTokens={contextWindowTokens}
        contextUsage={contextUsage}
        softRatio={softRatio}
        hardRatio={hardRatio}
      />

      {ratio !== null && softBannerShown && (
        <div className="px-4 py-2 bg-amber-900/20 border-b border-amber-700/40 text-amber-200 text-xs shrink-0 flex items-center justify-between gap-3">
          <span>Context is {Math.round(ratio * 100)}% full — consider starting a handoff</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={triggerHandoff}
              disabled={isTurnActive || handoffInFlight}
              className="btn btn-primary text-xs shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Handoff now
            </button>
            <button
              onClick={() => setSoftBannerShown(false)}
              aria-label="Dismiss"
              className="text-amber-300 hover:text-white text-xs shrink-0"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {ratio !== null && hardBannerShown && (
        <div
          role="alert"
          className="px-4 py-2 bg-red-900/30 border-b border-red-700/50 text-red-200 text-sm shrink-0 flex items-center justify-between gap-3"
        >
          <span>
            Context is critically full ({Math.round(ratio * 100)}%) — start a handoff now to avoid losing
            context
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={triggerHandoff}
              disabled={isTurnActive || handoffInFlight}
              className="btn btn-primary text-xs shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Handoff now
            </button>
            <button
              onClick={() => setHardBannerShown(false)}
              aria-label="Dismiss"
              className="text-red-300 hover:text-white text-xs shrink-0"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <div className="px-4 py-1 bg-slate-800/40 border-b border-slate-800 flex items-center justify-end gap-3 text-xs text-gray-500 shrink-0">
        {handoffInFlight && (
          <span className="flex items-center gap-1.5">
            Handing off…
            <span
              className="inline-block w-1.5 h-3 bg-gray-500 animate-pulse align-middle"
              aria-hidden="true"
            />
          </span>
        )}
        <button
          onClick={triggerHandoff}
          disabled={handoffInFlight || isTurnActive}
          className="text-xs px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Start handoff
        </button>
      </div>

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
        cancelState={{ active: isTurnActive || handoffInFlight, onCancel: cancel }}
      />
    </div>
  );
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
 * Legacy clipboard-copy technique via a temporary hidden textarea + the
 * deprecated `document.execCommand('copy')` API. Used as a fallback when
 * `navigator.clipboard` is unavailable, which happens whenever the page is
 * served from a non-secure context (plain HTTP, e.g. LAN dev-server access
 * at http://192.168.x.x:5173/) -- `navigator.clipboard` is undefined outside
 * HTTPS/localhost, so the modern API silently cannot be used there (#1159).
 */
function copyViaExecCommand(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Keep off-screen so it never affects layout or scroll position.
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

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
    let ok = false;
    let lastError: unknown;

    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (err) {
        lastError = err;
      }
    }

    // Fall back to the legacy execCommand('copy') technique when the
    // Clipboard API is unavailable (non-secure context, e.g. LAN access
    // over plain HTTP) or when it threw above.
    if (!ok) {
      try {
        ok = copyViaExecCommand(text);
        if (!ok) lastError = new Error('execCommand("copy") returned false');
      } catch (err) {
        lastError = err;
      }
    }

    if (!ok) {
      logger.error('Failed to copy markdown:', lastError);
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

interface ChatEntryRowProps {
  entry: OutsideEntry;
  onRestart: () => void;
}

function ChatEntryRow({ entry, onRestart }: ChatEntryRowProps) {
  switch (entry.kind) {
    case 'user-message':
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
    case 'context-handoff':
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
