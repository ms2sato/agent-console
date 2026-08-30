/**
 * Transcript Restore reconstitution (#1123).
 *
 * Reconstructs the LLM-facing ChatMessage[] conversation array from a
 * worker's persisted NDJSON output log, replacing v1's unconditional
 * fresh-epoch-and-truncate activation reset. Pure over already-fetched
 * data: the caller (EmbeddedAgentWorkerService) reads the persisted stream
 * and reassembles the system prompt (loadInstructions + assembleSystemPrompt
 * -- identical regardless of whether a compaction boundary exists); this
 * module never touches the filesystem.
 *
 * See docs/design/embedded-agent-worker.md "Transcript Restore":
 * - "Restore trigger & activation flow" steps 4a-4d
 * - "Runtime abort-repair vs. restore-time repair: parts cross-reference"
 * - "Compaction boundary"
 */
import * as v from 'valibot';
import {
  EmbeddedAgentStreamEventSchema,
  type EmbeddedAgentRestoredUsage,
  type EmbeddedAgentStreamEvent,
} from '@agent-console/shared';
import type { ChatMessage, ToolCall } from './providers/types.js';
import { buildCompactionSeedMessages } from './conversation-seed.js';
import { pushSyntheticToolError } from './tool-call-repair.js';

/** Row 4 of the parts cross-reference table: the restore-specific repair reason string. */
export const RESTORE_REPAIR_REASON =
  'tool call not completed: worker restarted before this response was recorded';

/** Thrown on any 4a-4c invariant violation (unparseable stream, schema-invalid line, a tool-call with no owning assistant-message). Caller must catch this and fall back to v1 reset (spec "Failure invariant (restore)"). */
export class RestoreReconstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreReconstructionError';
  }
}

export interface RestoreOutcome {
  conversation: ChatMessage[];
  /** Tool-call ids repaired by Tier C mid-turn repair (4d); empty when none needed. */
  repairedToolCallIds: string[];
  /**
   * How many restored entries came from the transcript, by this criterion:
   *
   *   An entry counts if and only if its content ORIGINATES FROM A LINE OF
   *   THE PERSISTED TRANSCRIPT.
   *
   * The criterion decides every entry on its own. A replayed message counts
   * -- it originates in its own row. A compaction summary counts -- it is
   * reconstructed from the `context-compacted` row, and it stands in for the
   * whole conversation head the compaction replaced. The synthetic system
   * prompt does NOT, and neither does a Tier C repair marker: both are
   * invented by this reconstruction so the provider will accept the array,
   * and neither originates in any row.
   *
   * It is written as a criterion rather than a list of exclusions because
   * the list was tried twice and was wrong twice. "Exclude the seed"
   * reported 0 for a worker killed immediately after a compaction, with
   * nothing yet replayed past the boundary -- suppressing the client's "your
   * conversation may not have carried over" notice, which is gated on this
   * being non-zero, at the exact moment the model has lost the most.
   * "Exclude only the system prompt" fixed that edge and silently
   * mis-classified a third synthetic category, the repair markers: counting
   * one double-counts an interaction the user sees once, since the tool call
   * it answers is already counted as the assistant message it arrived in. A
   * criterion answers for a fourth synthetic category that does not exist
   * yet; a list answers only for the three someone happened to think of.
   *
   * Two edges follow from the criterion, both deliberate:
   * - Empty transcript (activated, never spoken to) -> 0. Reachable, and
   *   the reason this is not simply `conversation.length`: the seed alone
   *   must not read as a restored conversation.
   * - Compaction boundary with zero following messages -> 1, the summary.
   *
   * This is the SINGLE WRITER of the count. The server must not recompute
   * it from the returned array: applying the criterion needs the shape of
   * the seed (one message normally, two past a boundary) and the identity of
   * every synthetic entry.
   *
   * The seed's shape is NOT this module's private business, though it reads
   * that way. `agent-loop`'s `restoredAtActivation` gates on
   * `restoredConversation.length > 1` -- a second deliberate consumer, in
   * another package, of the same invariant this count rests on: **the
   * synthetic prefix of a restored conversation is exactly one leading
   * system message.** That `> 1` is the subprocess-local projection of the
   * criterion above, and the two coincide on every reachable shape. Changing
   * the seed's shape therefore breaks two sites, and nothing but this
   * sentence connects them.
   */
  restoredMessageCount: number;
  /**
   * The newest authoritative context reading in the log, for the subprocess's
   * restore-boundary compaction check to be decided by, in place of
   * re-estimating the reconstructed text. Absent when the log holds no
   * reading at all -- see {@link findRestoredUsageSeed}.
   */
  usageSeed?: EmbeddedAgentRestoredUsage;
}

/**
 * 4a (parse) + 4b (locate the compaction boundary) + 4c (total
 * classification/replay) + 4d (Tier C mid-turn repair). `systemPrompt` is
 * the caller's already-reassembled prompt.
 */
export function reconstructConversation(
  streamText: string,
  systemPrompt: string,
  /**
   * Did the caller's output file rotate? `true` iff the live window's base
   * offset is non-zero -- a fact the READER cannot see (it gets text) and the
   * CALLER always has (`readHistoryWithOffset`'s `startOffset`).
   *
   * Required rather than defaulted, because a wrong answer is silent in both
   * directions: `false` on a rotated file loses a recoverable conversation,
   * and `true` on an intact one spends the corruption detection below. There
   * is one production caller; every other is a test declaring which world it
   * is in.
   */
  truncated: boolean,
): RestoreOutcome {
  const { events, skippedFragment } = parseStreamEvents(streamText, truncated);

  const boundaryIndex = findLastBoundaryIndex(events);

  // A rescued fragment window is only restored from a DECLARED discard.
  //
  // Skipping the fragment is not by itself enough to make the result honest:
  // the window still opens wherever the byte cut fell, so a restore from it
  // would be a partial conversation presented as a whole one -- an answer to
  // a question the user cannot see, with nothing saying so. Whether that is
  // acceptable is #1202 Gap 1's judgment and it has not been made.
  //
  // A compaction boundary is the one case that needs no such judgment: it is
  // an ALREADY-DECLARED discard, and slicing at it drops the mid-turn debris
  // the cut produced, so the window starts at a turn boundary. Restoring from
  // there is honest in the sense the divergence notice means.
  //
  // Everything else keeps today's behaviour -- reset with the log preserved
  // to a sidecar -- so the design space stays open instead of being settled
  // by a side effect of this fix.
  if (skippedFragment && boundaryIndex === -1) {
    throw new RestoreReconstructionError(
      'Rotation fragment skipped but the window holds no compaction boundary; a partial restore here would be undeclared',
    );
  }
  let conversation: ChatMessage[];
  let windowEvents: EmbeddedAgentStreamEvent[];
  if (boundaryIndex === -1) {
    conversation = [{ role: 'system', content: systemPrompt }];
    windowEvents = events;
  } else {
    conversation = buildCompactionSeedMessages(systemPrompt, boundarySummary(events[boundaryIndex]));
    windowEvents = events.slice(boundaryIndex + 1);
  }

  replayWindow(conversation, windowEvents);

  // Taken BEFORE the repair, which is what applies the criterion to the
  // markers it inserts: none of them originates in a transcript line, so
  // none of them counts. At this point every entry does originate in one
  // except the leading synthetic system prompt -- the boundary branch's
  // summary included, since it is reconstructed from the boundary event
  // rather than assembled fresh -- so the count is the length minus that
  // one seed message.
  const restoredMessageCount = conversation.length - 1;

  const repairResult = repairDanglingToolCalls(conversation);

  // The seed is read off the SAME parse and the SAME boundary index the
  // conversation was built from, rather than re-walking the stream: the rule
  // "never a reading from before the last boundary" is not a second policy to
  // keep in step with 4b, it IS 4b's window.
  const usageSeed = findRestoredUsageSeed(events, boundaryIndex);

  return {
    conversation: repairResult.conversation,
    repairedToolCallIds: repairResult.repairedToolCallIds,
    restoredMessageCount,
    ...(usageSeed !== undefined ? { usageSeed } : {}),
  };
}

/**
 * The newest **authoritative context reading** in a restored worker's
 * persisted log -- the number that seeds the restore-boundary
 * compaction check in place of re-estimating the reconstructed text.
 *
 * Two event kinds are readings, and the newer of them wins:
 *
 * - a `context-usage`, which is what the loop publishes after every turn (and
 *   after every compaction attempt) that produced a usable value;
 * - a `context-compacted`'s `postTokens`, which is itself a reading -- the
 *   size of the conversation the compaction left behind.
 *
 * `boundaryIndex` is 4b's own result, and passing it in is what makes the
 * ordering rule structural rather than a second implementation of it. A
 * `context-usage` from **before** the last boundary must never be the seed:
 * it measures a conversation that boundary then discarded, so it overstates
 * what remains by however much the compaction removed -- which for an
 * aggressive one is nearly everything. Only readings strictly after the
 * boundary are eligible; if there are none, the boundary's own `postTokens`
 * is the newest reading there is.
 *
 * Returns undefined when the log holds no reading at all. That is a
 * legitimate state, not a fault: a worker killed before completing any turn
 * never published one, and the subprocess's estimator fallback -- bias and
 * all -- is what remains for it.
 *
 * `estimated` travels with the number rather than being recomputed here. A
 * reading the previous incarnation had to estimate must not arrive at the
 * next one dressed as a measurement.
 */
export function findRestoredUsageSeed(
  events: EmbeddedAgentStreamEvent[],
  boundaryIndex: number,
): EmbeddedAgentRestoredUsage | undefined {
  for (let i = events.length - 1; i > boundaryIndex; i--) {
    const event = events[i];
    if (event.type === 'context-usage') {
      return { promptTokens: event.promptTokens, estimated: event.estimated };
    }
  }
  if (boundaryIndex === -1) return undefined;
  const boundary = events[boundaryIndex];
  // Only `context-compacted` carries a post-size. The legacy
  // `context-handoff` never did, so a stream cut by one has no reading at or
  // after its boundary and correctly yields nothing.
  if (boundary.type === 'context-compacted' && boundary.postTokens !== undefined) {
    // A compaction's own post-size is the loop's chars/4 estimate of the seed
    // it just built, never a provider number -- so it reports itself as an
    // estimate even though it is the newest reading available.
    return { promptTokens: boundary.postTokens, estimated: true };
  }
  return undefined;
}

function parseStreamEvents(
  streamText: string,
  allowLeadingFragment: boolean,
): { events: EmbeddedAgentStreamEvent[]; skippedFragment: boolean } {
  const events: EmbeddedAgentStreamEvent[] = [];
  let skippedFragment = false;
  // The window this reads starts at the live file's base offset, and rotation
  // cuts that file at a byte offset. The cut is newline-aligned now, but two
  // cases still hand this function a partial first record: a file rotated
  // before that alignment existed, and the documented fallback where no usable
  // newline was available. So the FIRST content line -- and only it -- may be
  // the tail of a record whose head was archived, and is dropped rather than
  // failing the reconstruction.
  //
  // **The tail deliberately stays strict, and the asymmetry is the contract.**
  // A broken line anywhere after the first is not explained by the cut: the
  // only writer appends whole lines, so a bad line in the middle or at the end
  // means the file was damaged some other way -- most likely a process killed
  // mid-write. That is a real corruption signal and it must stay loud. Making
  // the tail tolerant would convert every such truncation into a silent
  // partial restore.
  //
  // **Gated on the file having actually rotated.** A fragment at the head of a
  // file that was never cut is not a fragment -- it is corruption, and this
  // function is the only thing that detects it. An unconditional skip would
  // trade that detection away for a rescue the caller does not even need.
  let isFirstContentLine = true;
  for (const rawLine of streamText.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    // Consumed whether or not this line turns out to be valid: the allowance
    // is "the first record may be a fragment", not "one bad line anywhere".
    const mayBeRotationFragment = allowLeadingFragment && isFirstContentLine;
    isFirstContentLine = false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      if (mayBeRotationFragment) {
        skippedFragment = true;
        continue;
      }
      throw new RestoreReconstructionError(
        `Unparseable line in persisted stream: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = v.safeParse(EmbeddedAgentStreamEventSchema, parsed);
    if (!result.success) {
      // Both failure modes are covered, not just the throw: a cut can land
      // where the remaining bytes happen to be valid JSON -- inside a nested
      // object, say -- and produce a well-formed value that is not an event.
      // Tolerating only the parse error would leave that case failing exactly
      // as before, for a reason a reader would have to reconstruct.
      if (mayBeRotationFragment) {
        skippedFragment = true;
        continue;
      }
      throw new RestoreReconstructionError('Persisted stream line failed EmbeddedAgentStreamEvent schema validation');
    }
    events.push(result.output);
  }
  return { events, skippedFragment };
}

/**
 * The event kinds that cut the restore window. Both are compaction
 * boundaries: `context-compacted` is what engines emit today, and
 * `context-handoff` is the retired marker persisted before compaction
 * replaced handoff (#1401).
 *
 * The legacy kind is NOT optional to handle. A stream that still carries one
 * would otherwise replay its entire pre-handoff history on every restore --
 * resurrecting exactly the context the handoff deliberately discarded, and
 * (once auto compaction exists) undoing the compaction on every activation.
 */
const BOUNDARY_EVENT_TYPES = new Set<EmbeddedAgentStreamEvent['type']>([
  'context-compacted',
  'context-handoff',
]);

function findLastBoundaryIndex(events: EmbeddedAgentStreamEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (BOUNDARY_EVENT_TYPES.has(events[i].type)) return i;
  }
  return -1;
}

/**
 * The summary text a boundary event seeds the reconstructed conversation
 * with. `context-compacted`'s `summary` is optional on the wire (the
 * `claude-sdk` engine may have none) -- but that engine's conversation is
 * owned by the SDK and never reconstructed here, so an absent summary in
 * this path means a boundary with nothing to carry forward, and the empty
 * string is the honest seed rather than an invented one.
 */
function boundarySummary(event: EmbeddedAgentStreamEvent): string {
  if (event.type === 'context-compacted') return event.summary ?? '';
  if (event.type === 'context-handoff') return event.distillation;
  return '';
}

/**
 * 4c: total classification over every EmbeddedAgentStreamEvent union member
 * (mutates `conversation` in place). Mapped (4): user-message,
 * assistant-message, tool-call, tool-result. Noise (9, skipped):
 * assistant-delta, assistant-thinking-delta, state, context-usage, ready,
 * exited, turn-error, fatal, sdk-session-id. Boundary (2, never reached here
 * -- already sliced out by 4b): context-compacted and the legacy
 * context-handoff.
 */
function replayWindow(conversation: ChatMessage[], events: EmbeddedAgentStreamEvent[]): void {
  let current: Extract<ChatMessage, { role: 'assistant' }> | null = null;
  const knownToolCallIds = new Set<string>();
  /**
   * Whether a `user-message` has been replayed in this window yet.
   *
   * This is the discriminator between the two ways a `tool-call` can arrive
   * with no assistant message open, which look identical at that point and
   * deserve opposite treatment:
   *
   * - **A turn that legitimately opens with a tool call.** The engine emitted
   *   the call before the (empty) assistant flush of the same iteration. The
   *   turn's own `user-message` is in the window, so `turnBegun` is true. The
   *   conversation is COMPLETE and merely in an unexpected order, and the
   *   right answer is to open the assistant message the writer had not
   *   emitted yet.
   * - **Debris from a window that began mid-turn.** The cut fell inside a
   *   turn, so that turn's `user-message` is on the other side of it and
   *   `turnBegun` is still false. The conversation is TRUNCATED, and
   *   synthesising an assistant message here would present a fragment as
   *   though it were whole -- silently, since nothing downstream marks a
   *   reconstruction as partial.
   *
   * Only the first is tolerated. The second keeps throwing, which is what
   * leaves the question of how a truncated window should behave open for the
   * design decision that owns it rather than answering it by side effect.
   */
  let turnBegun = false;
  /**
   * Whether `current` is an assistant message this function synthesised for a
   * leading `tool-call`, and is therefore still waiting for the writer's own
   * flush of that same iteration.
   *
   * It exists so the two orders converge on ONE assistant message rather than
   * two. Without it the engine's own `assistant-message`, arriving after the
   * call it belongs with, would push a second message and split one assistant
   * turn in half -- which the provider sees as a different conversation from
   * the one the other engine's order produces.
   */
  let implicitAssistantOpen = false;

  for (const event of events) {
    switch (event.type) {
      case 'user-message':
        conversation.push({ role: 'user', content: event.text });
        current = null;
        implicitAssistantOpen = false;
        turnBegun = true;
        break;
      case 'assistant-message': {
        // The flush of the iteration whose tool call already opened this
        // message: adopt its text instead of starting a second one. Only the
        // FIRST assistant-message after a synthesised open may do this -- the
        // flag is cleared here, so a later message in the same window (the
        // turn's real prose, after the tool results) still begins its own.
        if (implicitAssistantOpen && current !== null) {
          current.content = event.text;
          implicitAssistantOpen = false;
          break;
        }
        const message: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', content: event.text };
        conversation.push(message);
        current = message;
        implicitAssistantOpen = false;
        break;
      }
      case 'tool-call': {
        if (current === null) {
          // Debris, not order: no turn has begun in this window, so the call
          // belongs to one whose start was cut away. See `turnBegun`.
          if (!turnBegun) {
            throw new RestoreReconstructionError(
              `tool-call event (callId=${event.callId}) with no preceding assistant-message in the restore window`,
            );
          }
          const opened: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', content: '' };
          conversation.push(opened);
          current = opened;
          implicitAssistantOpen = true;
        }
        const toolCall: ToolCall = {
          id: event.callId,
          type: 'function',
          function: {
            name: event.name,
            arguments: typeof event.args === 'string' ? event.args : JSON.stringify(event.args),
          },
        };
        current.tool_calls = [...(current.tool_calls ?? []), toolCall];
        knownToolCallIds.add(event.callId);
        break;
      }
      case 'tool-result':
        // A rotated-out restore window can start mid-turn, e.g. a lone
        // tool-result whose owning tool-call was archived out (restore only
        // reads the live output window, never archived segments). Without
        // this guard, an orphan tool-result silently produces a
        // structurally-invalid request (a tool-role message with no
        // preceding assistant tool_calls entry introducing that id) that the
        // provider rejects on every subsequent turn -- wedging the worker
        // instead of routing through the safe v1-reset fallback that every
        // other invariant violation already gets.
        if (!knownToolCallIds.has(event.callId)) {
          throw new RestoreReconstructionError(
            `tool-result event (callId=${event.callId}) with no owning tool-call in the restore window`,
          );
        }
        conversation.push({ role: 'tool', tool_call_id: event.callId, content: event.result });
        break;
      case 'assistant-delta':
      case 'assistant-thinking-delta':
      case 'state':
      case 'context-usage':
      case 'ready':
      case 'exited':
      case 'turn-error':
      case 'fatal':
      case 'sdk-session-id':
      case 'sdk-resume-failed':
      case 'turn-interrupted':
        // Noise: replay-only, contributes nothing to the conversation array.
        // sdk-session-id (SDK Engine Phase 1) carries no conversational
        // content -- it is a bookkeeping marker for the worker's current SDK
        // session id, unrelated to transcript reconstruction.
        // sdk-resume-failed and turn-interrupted (R1) are likewise
        // display-and-bookkeeping only: they say something about the
        // PROCESS's history, not about what was said. Feeding either into
        // the conversation array would put a claim in front of the model
        // that no participant ever made -- and turn-interrupted in
        // particular must not become a second, contradictory writer of the
        // repair that Mid-turn Repair already performs on this same array.
        break;
      case 'context-compacted':
      case 'context-handoff':
        // Boundary: unreachable here -- 4b already excluded both from
        // `events` by slicing strictly after the most recent one.
        break;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }
}

/**
 * 4d: Tier C mid-turn repair, applied to the fully reconstructed array.
 * Returns a NEW array (does not mutate `conversation` in place) with a
 * synthetic repair inserted immediately after each assistant message that
 * has a dangling tool_call_id -- positioned there (not appended to the tail
 * of the whole array) so repeated restores across multiple turns cannot
 * place a repair AFTER a later turn's messages, which would violate the
 * provider's structural contract (every tool_call_id must be answered
 * before the NEXT assistant message, not merely "somewhere in the array").
 */
function repairDanglingToolCalls(conversation: ChatMessage[]): { conversation: ChatMessage[]; repairedToolCallIds: string[] } {
  const responded = new Set<string>();
  for (const msg of conversation) {
    if (msg.role === 'tool') responded.add(msg.tool_call_id);
  }
  const repaired: string[] = [];
  const result: ChatMessage[] = [];
  for (const msg of conversation) {
    result.push(msg);
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (!responded.has(tc.id)) {
          pushSyntheticToolError(result, tc.id, RESTORE_REPAIR_REASON);
          repaired.push(tc.id);
        }
      }
    }
  }
  return { conversation: result, repairedToolCallIds: repaired };
}
