import { describe, it, expect } from 'bun:test';
import { buildShrunkDistillationInput, selectPartialDistillationMessages } from '../agent-loop';
import type { ChatMessage } from '../providers/types';

/**
 * Measured reach, recorded by WHICH test failed (standing rule). Mutations
 * applied to `buildShrunkDistillationInput` and this file re-run:
 *
 *   s1  reverse the shrink ordering (smallest-first)
 *       -> 1 fail, alone: 'shrinks the largest tool result first'. This is the
 *          ordering pin AC revision 4 requires, and only a tool-heavy fixture
 *          can see it -- with one big result the order is unobservable.
 *   s2  drop messages instead of shrinking (delegate straight to the selector)
 *       -> 5 fail: pairing, question-survives, ordering, the elision marker,
 *          and the small-window case. Predicted 3 and measured 5 -- the two
 *          extra are the ordering and marker pins, which cannot hold when
 *          nothing is shrunk at all. The spread is the point: the properties
 *          shrinking buys are independent, and selection loses every one.
 *   s3  return the assembled input unshrunk when it overruns
 *       -> 4 fail: 'fits the budget after shrinking', ordering, the marker,
 *          and the honest-degradation case. Predicted 2 and measured 4.
 *
 * Two of these three predictions were low. Recorded because the standing rule
 * says predicted reach is wrong in both directions often enough that
 * prediction is not evidence -- here it was wrong in the same direction twice,
 * which is exactly the shape that makes a pin look narrower than it is.
 *
 * The tool-heavy fixtures below exist because every pre-existing distillation
 * test is dialogue-shaped, so none of them could distinguish the strategies --
 * a change to selection would have looked safe.
 */

const BIG = (n: number, fill: string): string => fill.repeat(n);

function toolHeavyConversation(): ChatMessage[] {
  return [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Find where the retry budget is defined and explain it.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_a', content: BIG(4000, 'aaaa') },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_b', type: 'function', function: { name: 'Read', arguments: '{"path":"b.ts"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_b', content: BIG(1000, 'bbbb') },
  ] as ChatMessage[];
}

const PROMPT: ChatMessage = { role: 'user', content: 'Summarise the conversation so far.' };

describe('buildShrunkDistillationInput', () => {
  it('returns the input untouched when it already fits', () => {
    const convo: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ];
    const out = buildShrunkDistillationInput(convo, PROMPT, 100_000);
    expect(out).not.toBeNull();
    expect(out!.map((m) => m.content)).toEqual(['sys', 'hello', PROMPT.content]);
  });

  it('fits the budget after shrinking', () => {
    const out = buildShrunkDistillationInput(toolHeavyConversation(), PROMPT, 2_000);
    expect(out).not.toBeNull();
    const chars = out!.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
    expect(chars / 4).toBeLessThanOrEqual(2_000);
  });

  it('keeps every message, so each tool_call still has its matching tool message', () => {
    // The restore-boundary pairing invariant, satisfied by construction rather
    // than by care: a mid-turn boundary is only a valid restore point if every
    // issued tool_call has its result, and shrinking never drops a message.
    const out = buildShrunkDistillationInput(toolHeavyConversation(), PROMPT, 2_000)!;
    const callIds = out
      .flatMap((m) => ('tool_calls' in m && Array.isArray(m.tool_calls) ? m.tool_calls : []))
      .map((c: { id: string }) => c.id);
    const resultIds = out.filter((m) => m.role === 'tool').map((m) => (m as { tool_call_id: string }).tool_call_id);
    expect(callIds.sort()).toEqual(['call_a', 'call_b']);
    expect(resultIds.sort()).toEqual(['call_a', 'call_b']);
  });

  it("keeps the user's original question, which tail selection would discard", () => {
    // The concrete harm the strategy change exists to prevent: mid-turn the
    // tail is the bloat, so keeping the tail keeps the tool dumps and drops
    // the question the summary is supposed to be about.
    const out = buildShrunkDistillationInput(toolHeavyConversation(), PROMPT, 2_000)!;
    expect(out.some((m) => m.role === 'user' && String(m.content).includes('retry budget'))).toBe(true);

    const selected = selectPartialDistillationMessages(toolHeavyConversation(), PROMPT, 2_000);
    const selectionKeptTheQuestion =
      selected !== null && selected.some((m) => m.role === 'user' && String(m.content).includes('retry budget'));
    expect(selectionKeptTheQuestion).toBe(false);
  });

  it('shrinks the largest tool result first', () => {
    // Ordering pin. Budget chosen so exactly ONE shrink suffices: the large
    // result must be the one that gave way, and the small one must survive
    // whole. Smallest-first would shrink `call_b`, still overrun, and then
    // shrink `call_a` too -- leaving both damaged.
    const out = buildShrunkDistillationInput(toolHeavyConversation(), PROMPT, 1_800)!;
    const a = out.find((m) => m.role === 'tool' && (m as { tool_call_id: string }).tool_call_id === 'call_a')!;
    const b = out.find((m) => m.role === 'tool' && (m as { tool_call_id: string }).tool_call_id === 'call_b')!;
    expect(String(a.content)).toContain('[elided: original 16000 bytes]');
    expect(String(b.content)).toBe(BIG(1000, 'bbbb'));
  });

  it('marks a shrunk result with its original size rather than truncating silently', () => {
    const out = buildShrunkDistillationInput(toolHeavyConversation(), PROMPT, 2_000)!;
    const shrunkOnes = out.filter((m) => m.role === 'tool' && String(m.content).includes('[elided:'));
    expect(shrunkOnes.length).toBeGreaterThan(0);
    for (const m of shrunkOnes) {
      expect(String(m.content)).toMatch(/\[elided: original \d+ bytes\]$/);
    }
  });

  it('fires in the small-window regime where tail selection cannot', () => {
    // The dead zone. Below roughly W < 6,000 the selector's first candidate
    // already overruns and it returns null -- inside the very regime the
    // escape exists for. Shrinking still produces a usable input there.
    const budget = 900;
    expect(selectPartialDistillationMessages(toolHeavyConversation(), PROMPT, budget)).toBeNull();
    const out = buildShrunkDistillationInput(toolHeavyConversation(), PROMPT, budget);
    expect(out).not.toBeNull();
    expect(out!.some((m) => m.role === 'user' && String(m.content).includes('retry budget'))).toBe(true);
  });

  it('degrades honestly when even shrinking cannot fit, rather than appearing to fire', () => {
    // A conversation whose bulk is NOT tool output: shrinking has nothing to
    // give, the fallback selector cannot fit it either, and the answer is
    // null. Returning something unusable would be worse than failing.
    const convo: ChatMessage[] = [
      { role: 'system', content: BIG(20_000, 'ssss') },
      { role: 'user', content: BIG(20_000, 'uuuu') },
    ];
    expect(buildShrunkDistillationInput(convo, PROMPT, 100)).toBeNull();
  });
});
