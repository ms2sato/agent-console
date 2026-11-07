import { describe, it, expect } from 'bun:test';
import {
  INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH,
  INBOUND_WEBHOOK_LABEL_MAX_LENGTH,
} from '../inbound-webhook-endpoint';

describe('inbound webhook endpoint limits', () => {
  it('pin the approved values', () => {
    expect(INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH).toBe(4000);
    expect(INBOUND_WEBHOOK_LABEL_MAX_LENGTH).toBe(100);
  });
});
