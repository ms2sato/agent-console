import { describe, it, expect } from 'bun:test';
import { validateInstructionText, validateLabel, validateEnteredSecret, buildReceiveUrl } from '../inbound-webhook-form';

/** `whsec_` + base64 of `bytes` bytes. */
function secretOfBytes(bytes: number): string {
  return `whsec_${Buffer.alloc(bytes, 7).toString('base64')}`;
}

describe('validateInstructionText', () => {
  it('accepts a normal line and multi-line text (LF, CR, CRLF)', () => {
    expect(validateInstructionText('Triage this message')).toBeNull();
    expect(validateInstructionText('line1\nline2')).toBeNull();
    expect(validateInstructionText('line1\r\nline2\rline3\n')).toBeNull();
  });

  it('accepts exactly 4000 characters and rejects 4001', () => {
    expect(validateInstructionText('a'.repeat(4000))).toBeNull();
    expect(validateInstructionText('a'.repeat(4001))).toMatch(/at most 4000/);
  });

  it('rejects empty and whitespace-only input, including line breaks only', () => {
    expect(validateInstructionText('')).toMatch(/required/);
    expect(validateInstructionText('   ')).toMatch(/required/);
    expect(validateInstructionText('\n \r\n')).toMatch(/required/);
  });
});

describe('validateLabel', () => {
  it('accepts 1 and 100 characters, rejects empty, blank and 101', () => {
    expect(validateLabel('a')).toBeNull();
    expect(validateLabel('a'.repeat(100))).toBeNull();
    expect(validateLabel('')).toMatch(/required/);
    expect(validateLabel('   ')).toMatch(/required/);
    expect(validateLabel('a'.repeat(101))).toMatch(/at most 100/);
  });

  it('measures the trimmed value', () => {
    expect(validateLabel(` ${'a'.repeat(100)} `)).toBeNull();
  });
});

describe('validateEnteredSecret', () => {
  it('accepts 24 and 64 decoded bytes', () => {
    expect(validateEnteredSecret(secretOfBytes(24))).toBeNull();
    expect(validateEnteredSecret(secretOfBytes(64))).toBeNull();
  });

  it('rejects 23 and 65 decoded bytes', () => {
    expect(validateEnteredSecret(secretOfBytes(23))).toMatch(/24 to 64 bytes/);
    expect(validateEnteredSecret(secretOfBytes(65))).toMatch(/24 to 64 bytes/);
  });

  it('rejects a missing prefix, non-base64 characters, whitespace and a blank value', () => {
    expect(validateEnteredSecret(secretOfBytes(24).slice('whsec_'.length))).not.toBeNull();
    expect(validateEnteredSecret('whsec_!!!!')).not.toBeNull();
    expect(validateEnteredSecret(`${secretOfBytes(24)} `)).not.toBeNull();
    expect(validateEnteredSecret('')).not.toBeNull();
  });

  it('never echoes the entered value in the message', () => {
    for (const bad of ['whsec_SUPERSECRETVALUE!!', 'SUPERSECRETVALUE', secretOfBytes(23)]) {
      const message = validateEnteredSecret(bad) ?? '';
      expect(message).not.toContain('SUPERSECRETVALUE');
      expect(message).not.toContain(bad);
    }
  });
});

describe('buildReceiveUrl', () => {
  it('joins the origin and the path when the origin is set', () => {
    expect(buildReceiveUrl('https://hooks.example.com', 'ep-1')).toEqual({
      path: '/webhooks/in/ep-1',
      url: 'https://hooks.example.com/webhooks/in/ep-1',
      hasOrigin: true,
    });
  });

  it('falls back to the path when the origin is null', () => {
    expect(buildReceiveUrl(null, 'ep-1')).toEqual({ path: '/webhooks/in/ep-1', url: '/webhooks/in/ep-1', hasOrigin: false });
  });
});
