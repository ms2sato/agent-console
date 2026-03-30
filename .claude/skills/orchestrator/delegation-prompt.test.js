import { describe, expect, test } from 'bun:test';
import { extractSection, validate } from './delegation-prompt.js';

describe('extractSection', () => {
  test('extracts content between section heading and next heading', () => {
    const text = `### Affected Files
- \`src/foo.ts\`: add bar

### Key Functions/Types
doSomething(): void`;
    expect(extractSection(text, 'Affected Files')).toBe(
      '- `src/foo.ts`: add bar'
    );
    expect(extractSection(text, 'Key Functions/Types')).toBe(
      'doSomething(): void'
    );
  });

  test('extracts section at end of document (no trailing heading)', () => {
    const text = `### Testing Approach
Add unit tests in foo.test.ts`;
    expect(extractSection(text, 'Testing Approach')).toBe(
      'Add unit tests in foo.test.ts'
    );
  });

  test('returns null for missing section', () => {
    const text = `### Affected Files
- \`src/foo.ts\`: change`;
    expect(extractSection(text, 'Constraints')).toBeNull();
  });

  test('returns empty string for section with only HTML comments', () => {
    const text = `### Key Functions/Types
<!-- Function signatures or type definitions that will change -->

### Constraints`;
    expect(extractSection(text, 'Key Functions/Types')).toBe('');
  });

  test('strips HTML comments but keeps real content', () => {
    const text = `### Constraints
<!-- What NOT to change -->
Do not change public API

### Testing Approach`;
    expect(extractSection(text, 'Constraints')).toBe(
      'Do not change public API'
    );
  });

  test('stops at ## heading (not just ###)', () => {
    const text = `### Testing Approach
Run bun test

## Completion Steps
1. Do something`;
    expect(extractSection(text, 'Testing Approach')).toBe('Run bun test');
  });
});

describe('validate', () => {
  const validText = `### Affected Files
- \`src/services/auth.ts\`: add token validation

### Key Functions/Types
validateToken(token: string): boolean

### Constraints
Do not change existing API contracts

### Testing Approach
Add unit tests in auth.test.ts`;

  test('returns empty array for valid input', () => {
    expect(validate(validText)).toEqual([]);
  });

  test('detects missing Affected Files section', () => {
    const text = `### Key Functions/Types
foo()

### Constraints
none

### Testing Approach
tests`;
    const errors = validate(text);
    expect(errors).toContain('Missing "### Affected Files" section');
  });

  test('detects placeholder path', () => {
    const text = `### Affected Files
- \`path/to/file.ts\`: [current] → [change]

### Key Functions/Types
foo()

### Constraints
none

### Testing Approach
tests`;
    const errors = validate(text);
    expect(errors).toContain(
      '"Affected Files" contains placeholder path (path/to/file.ts)'
    );
  });

  test('detects missing backtick-quoted file path', () => {
    const text = `### Affected Files
some text without backtick paths

### Key Functions/Types
foo()

### Constraints
none

### Testing Approach
tests`;
    const errors = validate(text);
    expect(errors).toContain(
      '"Affected Files" must include at least one specific file path in backticks'
    );
  });

  test('accepts root-level file paths without slashes', () => {
    const text = `### Affected Files
- \`README.md\`: update docs

### Key Functions/Types
foo()

### Constraints
none

### Testing Approach
tests`;
    const errors = validate(text);
    expect(errors).toEqual([]);
  });

  test('detects empty Key Functions/Types', () => {
    const text = `### Affected Files
- \`src/foo.ts\`: change

### Key Functions/Types
<!-- Function signatures or type definitions that will change -->

### Constraints
none

### Testing Approach
tests`;
    const errors = validate(text);
    expect(errors).toContain(
      '"Key Functions/Types" section is empty or missing'
    );
  });

  test('detects empty Constraints', () => {
    const text = `### Affected Files
- \`src/foo.ts\`: change

### Key Functions/Types
foo()

### Constraints

### Testing Approach
tests`;
    const errors = validate(text);
    expect(errors).toContain('"Constraints" section is empty or missing');
  });

  test('detects empty Testing Approach', () => {
    const text = `### Affected Files
- \`src/foo.ts\`: change

### Key Functions/Types
foo()

### Constraints
none

### Testing Approach
<!-- Which test files to update, what new tests to add -->`;
    const errors = validate(text);
    expect(errors).toContain(
      '"Testing Approach" section is empty or missing'
    );
  });

  test('reports multiple errors at once', () => {
    const text = `### Affected Files
- \`path/to/file.ts\`: [current] → [change]

### Key Functions/Types

### Constraints

### Testing Approach`;
    const errors = validate(text);
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});
