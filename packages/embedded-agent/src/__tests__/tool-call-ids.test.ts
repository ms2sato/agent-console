import { describe, it, expect } from 'bun:test';
import type { ProviderToolCall } from '../agent-loop.js';
import { assignSyntheticToolCallIds } from '../tool-call-ids.js';

function call(callId: string, name = 'Read'): ProviderToolCall {
  return { callId, name, argsJson: '{}' };
}

describe('assignSyntheticToolCallIds', () => {
  it('assigns two distinct synthetic ids when two calls in one array both have an empty callId', () => {
    const result = assignSyntheticToolCallIds([call(''), call('')], 'turn-1', 2);

    expect(result).toHaveLength(2);
    expect(result[0]?.callId).toMatch(/^synthetic:turn-1:2:0$/);
    expect(result[1]?.callId).toMatch(/^synthetic:turn-1:2:1$/);
    expect(result[0]?.callId).not.toBe(result[1]?.callId);
  });

  it('leaves a provider-supplied non-empty callId byte-identical, including an id containing a colon', () => {
    const input = [call('call_abc123'), call('weird:id:with:colons')];
    const result = assignSyntheticToolCallIds(input, 'turn-1', 0);

    expect(result[0]?.callId).toBe('call_abc123');
    expect(result[1]?.callId).toBe('weird:id:with:colons');
  });

  it('only replaces the empty id in a mixed array, leaving the supplied one untouched', () => {
    const result = assignSyntheticToolCallIds([call('provided'), call('')], 'turn-9', 3);

    expect(result[0]?.callId).toBe('provided');
    expect(result[1]?.callId).toBe('synthetic:turn-9:3:1');
  });

  it('returns an empty array for an empty input', () => {
    expect(assignSyntheticToolCallIds([], 'turn-1', 0)).toEqual([]);
  });

  it('is deterministic: the same turnId/iteration/toolCalls produce the same output on a second call', () => {
    const input = [call(''), call('')];
    const first = assignSyntheticToolCallIds(input, 'turn-5', 1);
    const second = assignSyntheticToolCallIds(input, 'turn-5', 1);

    expect(second.map((c) => c.callId)).toEqual(first.map((c) => c.callId));
  });

  it('produces different ids for the same toolCalls when the iteration differs', () => {
    const input = [call('')];
    const iterationZero = assignSyntheticToolCallIds(input, 'turn-5', 0);
    const iterationOne = assignSyntheticToolCallIds(input, 'turn-5', 1);

    expect(iterationZero[0]?.callId).not.toBe(iterationOne[0]?.callId);
  });

  it('does not mutate the input array or its elements', () => {
    const original = call('');
    const input = [original];
    const result = assignSyntheticToolCallIds(input, 'turn-1', 0);

    expect(input[0]).toBe(original);
    expect(original.callId).toBe('');
    expect(result).not.toBe(input);
    expect(result[0]).not.toBe(original);
  });
});
