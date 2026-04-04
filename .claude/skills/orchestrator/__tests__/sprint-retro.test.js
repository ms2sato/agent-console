import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import {
  createStdinReader,
  getSteps,
  printStepHeader,
  printSummary,
  runRetro,
} from '../sprint-retro.js';

// --- Helper: create a readable stream that emits null-byte terminated data ---

function createMockStdin(answers) {
  const chunks = answers.map(a => a + '\0');
  let index = 0;
  return new Readable({
    read() {
      if (index < chunks.length) {
        this.push(Buffer.from(chunks[index]));
        index++;
      } else {
        this.push(null);
      }
    },
  });
}

// --- Tests ---

describe('getSteps', () => {
  it('returns 7 steps', () => {
    const steps = getSteps();
    expect(steps).toHaveLength(7);
  });

  it('returns steps with expected keys in order', () => {
    const steps = getSteps();
    const keys = steps.map(s => s.key);
    expect(keys).toEqual([
      'triage',
      'worktree_cleanup',
      'incident_review',
      'process_review',
      'apply_improvements',
      'memory_writeout',
      'cross_project',
    ]);
  });

  it('each step has title and instructions', () => {
    const steps = getSteps();
    for (const step of steps) {
      expect(step.title).toBeTruthy();
      expect(step.instructions).toBeInstanceOf(Array);
      expect(step.instructions.length).toBeGreaterThan(0);
    }
  });

  it('process_review step lists 4 review perspectives', () => {
    const steps = getSteps();
    const processReview = steps.find(s => s.key === 'process_review');
    const text = processReview.instructions.join('\n');
    expect(text).toContain('Redundant information');
    expect(text).toContain('Implicit knowledge');
    expect(text).toContain('Name-reality mismatches');
    expect(text).toContain('Owner-dependent discoveries');
  });
});

describe('printStepHeader', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints step title and instructions', () => {
    const step = {
      key: 'test',
      title: 'Step X: Test Step',
      instructions: ['Do something', 'Do another thing'],
    };
    printStepHeader(step);
    const output = logs.join('\n');
    expect(output).toContain('--- Step X: Test Step ---');
    expect(output).toContain('Do something');
    expect(output).toContain('Do another thing');
  });
});

describe('printSummary', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints all step responses', () => {
    const steps = [
      { key: 's1', title: 'Step 1' },
      { key: 's2', title: 'Step 2' },
    ];
    const responses = { s1: 'Response one', s2: 'Response two' };
    printSummary(responses, steps);
    const output = logs.join('\n');
    expect(output).toContain('Sprint Retrospective Summary');
    expect(output).toContain('[Step 1]');
    expect(output).toContain('Response one');
    expect(output).toContain('[Step 2]');
    expect(output).toContain('Response two');
  });

  it('truncates long responses to 200 chars', () => {
    const steps = [{ key: 's1', title: 'Step 1' }];
    const longResponse = 'x'.repeat(250);
    const responses = { s1: longResponse };
    printSummary(responses, steps);
    const output = logs.join('\n');
    expect(output).toContain('x'.repeat(200) + '...');
  });

  it('skips steps without responses', () => {
    const steps = [
      { key: 's1', title: 'Step 1' },
      { key: 's2', title: 'Step 2' },
    ];
    const responses = { s1: 'Only this one' };
    printSummary(responses, steps);
    const output = logs.join('\n');
    expect(output).toContain('[Step 1]');
    expect(output).not.toContain('[Step 2]');
  });
});

describe('createStdinReader', () => {
  it('reads multiple null-byte delimited responses', async () => {
    const stdin = createMockStdin(['first', 'second', 'third']);
    const readResponse = createStdinReader(stdin);
    expect(await readResponse()).toBe('first');
    expect(await readResponse()).toBe('second');
    expect(await readResponse()).toBe('third');
  });

  it('trims whitespace from responses', async () => {
    const stdin = createMockStdin(['  trimmed  ']);
    const readResponse = createStdinReader(stdin);
    expect(await readResponse()).toBe('trimmed');
  });
});

describe('runRetro', () => {
  let logSpy;
  let logs;

  beforeEach(() => {
    logs = [];
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('runs through all 7 steps and prints summary', async () => {
    const answers = [
      'Removed old item from triage',
      'Cleaned wt-001',
      'PR #100 went well',
      'No redundancies found',
      'Updated CLAUDE.md rule',
      'Deleted stale memory',
      'No other sessions',
    ];
    const stdin = createMockStdin(answers);
    await runRetro({ stdin });
    const output = logs.join('\n');

    // Verify header
    expect(output).toContain('=== Sprint Retrospective ===');

    // Verify all step titles appear
    const steps = getSteps();
    for (const step of steps) {
      expect(output).toContain(step.title);
    }

    // Verify all confirmation messages
    for (const step of steps) {
      expect(output).toContain(`✓ ${step.title} — recorded`);
    }

    // Verify summary includes responses
    expect(output).toContain('Sprint Retrospective Summary');
    for (const answer of answers) {
      expect(output).toContain(answer);
    }
  });

  it('presents steps in correct order', async () => {
    const answers = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    const stdin = createMockStdin(answers);
    await runRetro({ stdin });
    const output = logs.join('\n');

    const steps = getSteps();
    let lastIndex = -1;
    for (const step of steps) {
      const idx = output.indexOf(`--- ${step.title} ---`);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it('collects responses and maps them to step keys', async () => {
    const answers = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
    const stdin = createMockStdin(answers);
    await runRetro({ stdin });
    const output = logs.join('\n');

    // Summary should contain all responses
    expect(output).toContain('r1');
    expect(output).toContain('r7');
  });

  it('handles empty responses gracefully', async () => {
    const answers = ['', '', '', '', '', '', ''];
    const stdin = createMockStdin(answers);
    await runRetro({ stdin });
    const output = logs.join('\n');

    // Should still complete without errors
    expect(output).toContain('Sprint Retrospective Summary');
    const steps = getSteps();
    for (const step of steps) {
      expect(output).toContain(`✓ ${step.title} — recorded`);
    }
  });
});
