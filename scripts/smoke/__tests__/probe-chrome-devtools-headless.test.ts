/**
 * Verdict classifier, reading builder, image walker and entry edits for
 * `scripts/smoke/probe-chrome-devtools-headless.ts`.
 *
 * The probe is billable and needs a real, authenticated `claude` CLI plus a
 * User-scope `chrome-devtools` server on the host, so its measurement is never
 * run here. Everything below is pure: it reads plain readings and tool-response
 * values handed to it, and importing the module runs nothing (the
 * `import.meta.main` guard), so the decision layer is pinned at zero cost and
 * separately from what it decides about.
 *
 * What the pins protect: an unsettled turn must never read as a negative
 * measurement; a control that ALSO takes a screenshot must never credit the
 * flag; a snap-only failure with a working apt retry must surface as the
 * operational answer, not as a plain failure; "nothing connected anywhere" is
 * inconclusive, not a measured negative; and an empty tool response is zero
 * image bytes, never an image.
 */
import { describe, it, expect } from 'bun:test';
import {
  APT_CHROMIUM_PATH,
  BROWSER_MCP,
  PROBE_EXIT,
  classifyProbe,
  executablePathOf,
  exitCodeFor,
  formatReadingsTable,
  imageBytesIn,
  parseArgs,
  parseStdioEntry,
  readArm,
  registrationCommand,
  screenshotTaken,
  shouldRetryWithAptPath,
  summarizeResponseShape,
  turnPrompts,
  withExecutablePath,
  withHeadless,
  withoutHeadless,
  type ArmReading,
  type RawArmObservation,
  type StdioEntry,
} from '../probe-chrome-devtools-headless.js';

const WORKED: ArmReading = { settled: true, connected: true, toolFired: true, imageBytes: 1234, error: null };
const CONNECTED_NO_IMAGE: ArmReading = { settled: true, connected: true, toolFired: true, imageBytes: 0, error: 'Failed to launch the browser process' };
const NOT_CONNECTED: ArmReading = { settled: true, connected: false, toolFired: false, imageBytes: 0, error: 'spawn failed' };
const UNSETTLED: ArmReading = { settled: false, connected: false, toolFired: false, imageBytes: 0, error: null };

const SNAP = '/snap/chromium/current/usr/lib/chromium-browser/chrome';
const HOST_ENTRY: StdioEntry = {
  type: 'stdio',
  command: 'npx',
  args: ['chrome-devtools-mcp@latest', '--isolated', '--executablePath', SNAP, '--chromeArg=--no-sandbox'],
  env: {},
};

describe('classifyProbe', () => {
  it('headless succeeds and the control fails: the flag is credited, as configured', () => {
    const v = classifyProbe({ headless: WORKED, apt: null, control: CONNECTED_NO_IMAGE });
    expect(v.conclusive).toBe(true);
    expect(v.operational).toBe('headless-as-configured');
    expect(v.headlessCredited).toBe(true);
    expect(v.verdict).toContain('HEADLESS WORKS (as configured)');
    expect(v.verdict).toContain('connected but took no screenshot');
    expect(v.stops).toEqual([]);
  });

  it('headless succeeds and the control does not even connect', () => {
    const v = classifyProbe({ headless: WORKED, apt: null, control: NOT_CONNECTED });
    expect(v.headlessCredited).toBe(true);
    expect(v.verdict).toContain('did not connect');
  });

  it('both succeed: the verdict says so and the flag is NOT credited', () => {
    const v = classifyProbe({ headless: WORKED, apt: null, control: WORKED });
    expect(v.conclusive).toBe(true);
    expect(v.operational).toBe('headless-as-configured');
    expect(v.headlessCredited).toBe(false);
    expect(v.verdict).toContain('BOTH SUCCEED');
    expect(v.verdict).toContain('--headless is not what made it work');
    expect(v.stops).toEqual(['the control succeeded: do not credit --headless']);
  });

  it('headless fails on the snap path and the apt retry succeeds: the apt path is the operational answer', () => {
    const v = classifyProbe({ headless: CONNECTED_NO_IMAGE, apt: WORKED, control: CONNECTED_NO_IMAGE });
    expect(v.conclusive).toBe(true);
    expect(v.operational).toBe('headless-with-apt-path');
    expect(v.headlessCredited).toBe(true);
    expect(v.verdict).toContain(`only after replacing --executablePath with ${APT_CHROMIUM_PATH}`);
    expect(v.verdict).toContain('headless=[connected, tool fired, no image]');
    expect(v.verdict).toContain('headless-apt=[screenshot 1234 bytes]');
  });

  it('headless fails, apt succeeds, and the control also succeeds: not credited', () => {
    const v = classifyProbe({ headless: NOT_CONNECTED, apt: WORKED, control: WORKED });
    expect(v.operational).toBe('headless-with-apt-path');
    expect(v.headlessCredited).toBe(false);
    expect(v.verdict).toContain('BOTH SUCCEED');
  });

  it('both fail but something connected: a measured negative with a STOP line', () => {
    const v = classifyProbe({ headless: CONNECTED_NO_IMAGE, apt: CONNECTED_NO_IMAGE, control: NOT_CONNECTED });
    expect(v.conclusive).toBe(true);
    expect(v.operational).toBe('none');
    expect(v.headlessCredited).toBe(false);
    expect(v.verdict).toContain('NO ARM TOOK A SCREENSHOT');
    expect(v.stops).toHaveLength(1);
  });

  it('nothing connected on ANY arm is inconclusive, not a measured negative', () => {
    const v = classifyProbe({ headless: NOT_CONNECTED, apt: NOT_CONNECTED, control: NOT_CONNECTED });
    expect(v.conclusive).toBe(false);
    expect(v.headlessCredited).toBeNull();
    expect(v.verdict).toContain('nothing connected on any arm');
    expect(exitCodeFor(v)).toBe(PROBE_EXIT.INCONCLUSIVE);
  });

  it('an unsettled arm is inconclusive and named, even when another arm took a screenshot', () => {
    const v = classifyProbe({ headless: WORKED, apt: null, control: UNSETTLED });
    expect(v.conclusive).toBe(false);
    expect(v.operational).toBe('none');
    expect(v.verdict).toContain('control did not settle');
    const apt = classifyProbe({ headless: CONNECTED_NO_IMAGE, apt: UNSETTLED, control: NOT_CONNECTED });
    expect(apt.conclusive).toBe(false);
    expect(apt.verdict).toContain('headless-apt did not settle');
  });

  it('a screenshot on an unsettled arm does not count (unread is not a reading)', () => {
    expect(screenshotTaken({ ...WORKED, settled: false })).toBe(false);
    expect(screenshotTaken({ ...WORKED, connected: false })).toBe(false);
    expect(screenshotTaken({ ...WORKED, imageBytes: 0 })).toBe(false);
  });

  it('empty observations (everything absent, settled) read as not connected, hence inconclusive', () => {
    const empty = readArm({
      turn1Settled: true,
      turn2Ran: false,
      turn2Settled: false,
      initStatus: null,
      postStatus: null,
      turn1Calls: [],
      turn2Calls: [],
      errors: [],
    });
    expect(empty).toEqual({ settled: true, connected: false, toolFired: false, imageBytes: 0, error: null });
    const v = classifyProbe({ headless: empty, apt: null, control: empty });
    expect(v.conclusive).toBe(false);
  });
});

describe('exitCodeFor', () => {
  it('assigns distinct codes 0/1/2', () => {
    expect(new Set([PROBE_EXIT.MEASURED, PROBE_EXIT.INCONCLUSIVE, PROBE_EXIT.HARNESS]).size).toBe(3);
  });

  it('maps a conclusive verdict to MEASURED, an inconclusive one to INCONCLUSIVE, and no verdict to INCONCLUSIVE', () => {
    expect(exitCodeFor({ conclusive: true })).toBe(PROBE_EXIT.MEASURED);
    expect(exitCodeFor({ conclusive: false })).toBe(PROBE_EXIT.INCONCLUSIVE);
    expect(exitCodeFor(null)).toBe(PROBE_EXIT.INCONCLUSIVE);
  });

  it('a STOP-bearing conclusive verdict still reads MEASURED (a STOP is a measurement, not a failure)', () => {
    expect(exitCodeFor(classifyProbe({ headless: CONNECTED_NO_IMAGE, apt: null, control: CONNECTED_NO_IMAGE }))).toBe(PROBE_EXIT.MEASURED);
  });
});

describe('readArm', () => {
  const base: RawArmObservation = {
    turn1Settled: true,
    turn2Ran: true,
    turn2Settled: true,
    initStatus: 'pending',
    postStatus: 'connected',
    turn1Calls: [{ tool: 'mcp__chrome-devtools__list_pages', imageBytes: 0 }],
    turn2Calls: [
      { tool: 'mcp__chrome-devtools__navigate_page', imageBytes: 0 },
      { tool: 'mcp__chrome-devtools__take_screenshot', imageBytes: 900 },
    ],
    errors: ['', '  Failed   to\nlaunch '],
  };

  it('connected from either the init or the post-turn status; image is the largest across turns; first non-blank error, whitespace-collapsed', () => {
    expect(readArm(base)).toEqual({ settled: true, connected: true, toolFired: true, imageBytes: 900, error: 'Failed to launch' });
    expect(readArm({ ...base, initStatus: 'connected', postStatus: null }).connected).toBe(true);
    expect(readArm({ ...base, initStatus: 'failed', postStatus: 'failed' }).connected).toBe(false);
  });

  it('settled needs turn 1, and turn 2 only if it ran', () => {
    expect(readArm({ ...base, turn2Ran: false, turn2Settled: false }).settled).toBe(true);
    expect(readArm({ ...base, turn2Settled: false }).settled).toBe(false);
    expect(readArm({ ...base, turn1Settled: false }).settled).toBe(false);
  });

  it('truncates a long error', () => {
    expect(readArm({ ...base, errors: ['x'.repeat(1000)] }).error).toHaveLength(300);
  });
});

describe('imageBytesIn', () => {
  const b64 = (n: number): string => Buffer.alloc(n, 7).toString('base64');

  it('reads an MCP image block, with or without a content wrapper, as its decoded size', () => {
    expect(imageBytesIn([{ type: 'image', data: b64(100), mimeType: 'image/png' }])).toBe(100);
    expect(imageBytesIn({ content: [{ type: 'text', text: 'Took a screenshot' }, { type: 'image', data: b64(31) }] })).toBe(31);
  });

  it('reads an Anthropic-style source.data block', () => {
    expect(imageBytesIn([{ type: 'image', source: { type: 'base64', data: b64(64) } }])).toBe(64);
  });

  it('takes the largest of several images', () => {
    expect(imageBytesIn([{ type: 'image', data: b64(10) }, { type: 'image', data: b64(500) }])).toBe(500);
  });

  it('reads a JSON-serialized response at the top level only', () => {
    expect(imageBytesIn(JSON.stringify([{ type: 'image', data: b64(40) }]))).toBe(40);
    expect(imageBytesIn('plain text, no image')).toBe(0);
    expect(imageBytesIn('[not json')).toBe(0);
  });

  it('boundary values: nothing, empty containers and empty image data are 0, never an image', () => {
    expect(imageBytesIn(undefined)).toBe(0);
    expect(imageBytesIn(null)).toBe(0);
    expect(imageBytesIn([])).toBe(0);
    expect(imageBytesIn({})).toBe(0);
    expect(imageBytesIn([{ type: 'image', data: '' }])).toBe(0);
    expect(imageBytesIn([{ type: 'image' }])).toBe(0);
  });

  it('text that merely mentions an image, or a non-image block with a data field, is 0', () => {
    expect(imageBytesIn([{ type: 'text', text: 'image saved to /tmp/shot.png' }])).toBe(0);
    expect(imageBytesIn([{ type: 'resource', data: b64(50) }])).toBe(0);
  });

  it('stops walking at a bounded depth instead of recursing forever', () => {
    let deep: unknown = { type: 'image', data: b64(10) };
    for (let i = 0; i < 20; i++) deep = { wrap: deep };
    expect(imageBytesIn(deep)).toBe(0);
  });
});

describe('summarizeResponseShape', () => {
  it('redacts long data strings to their length and truncates', () => {
    const out = summarizeResponseShape([{ type: 'image', data: 'A'.repeat(5000) }]);
    expect(out).toContain('<5000 chars>');
    expect(out).not.toContain('AAAA');
    expect(summarizeResponseShape('x'.repeat(2000)).endsWith('...')).toBe(true);
    expect(summarizeResponseShape(undefined)).toBe('(undefined)');
  });
});

describe('entry edits', () => {
  it('withHeadless appends the flag once and never mutates its input', () => {
    const h = withHeadless(HOST_ENTRY);
    expect(h.args.at(-1)).toBe('--headless');
    expect(withHeadless(h).args.filter((a) => a === '--headless')).toHaveLength(1);
    expect(HOST_ENTRY.args).not.toContain('--headless');
  });

  it('withoutHeadless removes the flag in both spellings and leaves a flagless entry alone', () => {
    expect(withoutHeadless({ ...HOST_ENTRY, args: [...HOST_ENTRY.args, '--headless'] }).args).toEqual(HOST_ENTRY.args);
    expect(withoutHeadless({ ...HOST_ENTRY, args: [...HOST_ENTRY.args, '--headless=true'] }).args).toEqual(HOST_ENTRY.args);
    expect(withoutHeadless(HOST_ENTRY).args).toEqual(HOST_ENTRY.args);
  });

  it('executablePathOf reads both spellings and null when absent', () => {
    expect(executablePathOf(HOST_ENTRY)).toBe(SNAP);
    expect(executablePathOf({ ...HOST_ENTRY, args: [`--executablePath=${SNAP}`] })).toBe(SNAP);
    expect(executablePathOf({ ...HOST_ENTRY, args: ['x'] })).toBeNull();
    expect(executablePathOf({ ...HOST_ENTRY, args: ['--executablePath'] })).toBeNull();
  });

  it('withExecutablePath replaces the value, keeps every other arg in place, and appends when absent', () => {
    expect(withExecutablePath(HOST_ENTRY, APT_CHROMIUM_PATH).args).toEqual([
      'chrome-devtools-mcp@latest',
      '--isolated',
      '--executablePath',
      APT_CHROMIUM_PATH,
      '--chromeArg=--no-sandbox',
    ]);
    expect(withExecutablePath({ ...HOST_ENTRY, args: [`--executablePath=${SNAP}`] }, APT_CHROMIUM_PATH).args).toEqual([`--executablePath=${APT_CHROMIUM_PATH}`]);
    expect(withExecutablePath({ ...HOST_ENTRY, args: ['a'] }, APT_CHROMIUM_PATH).args).toEqual(['a', '--executablePath', APT_CHROMIUM_PATH]);
    expect(executablePathOf(HOST_ENTRY)).toBe(SNAP);
  });

  it('shouldRetryWithAptPath: only when no screenshot was taken and the path is not already the apt one', () => {
    expect(shouldRetryWithAptPath(HOST_ENTRY, CONNECTED_NO_IMAGE)).toBe(true);
    expect(shouldRetryWithAptPath(HOST_ENTRY, WORKED)).toBe(false);
    expect(shouldRetryWithAptPath(withExecutablePath(HOST_ENTRY, APT_CHROMIUM_PATH), CONNECTED_NO_IMAGE)).toBe(false);
    expect(shouldRetryWithAptPath({ ...HOST_ENTRY, args: ['x'] }, NOT_CONNECTED)).toBe(true);
  });
});

describe('parseStdioEntry', () => {
  it('accepts a stdio entry (type optional), defaulting args, and keeps extra keys verbatim', () => {
    expect(parseStdioEntry(HOST_ENTRY)).toEqual(HOST_ENTRY);
    expect(parseStdioEntry({ command: 'npx' })).toEqual({ command: 'npx', args: [] });
    expect(parseStdioEntry({ command: 'npx', alwaysLoad: true })?.alwaysLoad).toBe(true);
  });

  it('rejects anything that is not a stdio server with a command', () => {
    expect(parseStdioEntry(undefined)).toBeNull();
    expect(parseStdioEntry(null)).toBeNull();
    expect(parseStdioEntry('npx')).toBeNull();
    expect(parseStdioEntry([])).toBeNull();
    expect(parseStdioEntry({ type: 'http', url: 'http://x' })).toBeNull();
    expect(parseStdioEntry({ command: '' })).toBeNull();
    expect(parseStdioEntry({ command: 'npx', args: ['a', 1] })).toBeNull();
    expect(parseStdioEntry({ command: 'npx', env: { A: 1 } })).toBeNull();
  });
});

describe('registrationCommand', () => {
  it('builds the one-line user-scope registration from the entry', () => {
    const entry = withHeadless(withExecutablePath(HOST_ENTRY, APT_CHROMIUM_PATH));
    expect(registrationCommand('chrome-devtools', entry)).toBe(
      'claude mcp add -s user chrome-devtools -- npx chrome-devtools-mcp@latest --isolated --executablePath /usr/bin/chromium-browser --chromeArg=--no-sandbox --headless',
    );
  });

  it('quotes an argument with a space or a quote, and carries env as -e pairs', () => {
    const cmd = registrationCommand('x y', { command: 'node', args: ["it's", 'a b'], env: { TOKEN: 'a b' } });
    expect(cmd).toBe(`claude mcp add -s user -e 'TOKEN=a b' 'x y' -- node 'it'\\''s' 'a b'`);
  });
});

describe('turnPrompts, parseArgs, formatReadingsTable', () => {
  it('prompts name the exact mcp__<server>__<tool> for the server under test', () => {
    const p = turnPrompts(BROWSER_MCP);
    expect(p.list).toContain('mcp__chrome-devtools__list_pages');
    expect(p.screenshot).toContain('mcp__chrome-devtools__navigate_page');
    expect(p.screenshot).toContain('mcp__chrome-devtools__take_screenshot');
    expect(turnPrompts({ ...BROWSER_MCP, server: 'other' }).list).toContain('mcp__other__list_pages');
  });

  it('parseArgs: none runs, --help helps, anything else is an error naming it', () => {
    expect(parseArgs([])).toEqual({ kind: 'run' });
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--p0'])).toEqual({ kind: 'error', arg: '--p0' });
  });

  it('the table has one row per arm and marks a skipped arm', () => {
    const t = formatReadingsTable([
      { arm: 'headless', reading: CONNECTED_NO_IMAGE },
      { arm: 'headless-apt', reading: null },
      { arm: 'control', reading: WORKED },
    ]);
    const lines = t.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('image bytes');
    expect(lines[2]).toContain('Failed to launch the browser process');
    expect(lines[3]).toContain('(not attempted)');
    expect(lines[4]).toContain('1234');
  });
});
