import { describe, it, expect } from 'bun:test';
import type { ChatMessage } from '../providers/types.js';
import { pushSyntheticToolError } from '../tool-call-repair.js';

describe('pushSyntheticToolError', () => {
  it('mutates the given conversation array in place, pushing exactly one tool-role entry onto the end', () => {
    const conversation: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const returnValue = pushSyntheticToolError(conversation, 'call-1', 'tool call canceled');

    expect(returnValue).toBeUndefined();
    expect(conversation).toHaveLength(2);
    expect(conversation.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'Error: tool call canceled',
    });
  });

  it('pushes two distinct entries in call order when invoked twice with different toolCallIds', () => {
    const conversation: ChatMessage[] = [];
    pushSyntheticToolError(conversation, 'call-a', 'reason a');
    pushSyntheticToolError(conversation, 'call-b', 'reason b');

    expect(conversation).toEqual([
      { role: 'tool', tool_call_id: 'call-a', content: 'Error: reason a' },
      { role: 'tool', tool_call_id: 'call-b', content: 'Error: reason b' },
    ]);
  });
});
