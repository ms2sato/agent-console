import { describe, it, expect } from 'bun:test';
import {
  composePausedDigest,
  composeDeferredReadMore,
  type PausedDigestEntry,
  type PausedDigestOptions,
} from '../paused-digest.js';
import { buildPtyNotificationText } from '../pty-notification.js';

const PATH = '/data/sessions/s1/deferred/2026-10-24T02:00:00.000Z.md';
const OPTIONS: PausedDigestOptions = {
  pausedAt: '2026-10-24T01:00:00.000Z',
  resumedAt: '2026-10-24T02:00:00.000Z',
  path: PATH,
  maxEntries: 50,
  maxChars: 6000,
};

function at(second: number): string {
  return `2026-10-24T01:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.000Z`;
}

function message(id: string, createdAt: string, over: Partial<PausedDigestEntry> = {}, summary = `msg ${id}`): PausedDigestEntry {
  return {
    id,
    workerId: 'w1',
    kind: 'internal-message',
    params: {
      kind: 'internal-message',
      tag: 'internal:message',
      fields: { source: 'session', from: 'sender-1', summary, path: `/m/${id}.md` },
      intent: 'triage',
    },
    sourceId: `/m/${id}.md`,
    replyToSessionId: 'sender-1',
    createdAt,
    ...over,
  };
}

function processEntry(id: string, createdAt: string): PausedDigestEntry {
  return {
    id,
    workerId: 'w1',
    kind: 'internal-process',
    params: {
      kind: 'internal-process',
      tag: 'internal:process',
      fields: { processId: 'proc-1', command: 'sleep 5', message: `exited ${id}` },
      intent: 'inform',
    },
    sourceId: 'proc-1',
    replyToSessionId: null,
    createdAt,
  };
}

/** Entry lines of a body (everything that is a rendered `[tag]` line). */
function entryLines(body: string): string[] {
  return body.split('\n').filter((l) => l.startsWith('[internal:') || l.startsWith('[inbound:'));
}

describe('composePausedDigest', () => {
  it('returns null for zero rows (no digest)', () => {
    expect(composePausedDigest([], OPTIONS)).toBeNull();
  });

  it('lists entries oldest first even when the input is not ordered', () => {
    const digest = composePausedDigest(
      [message('c', at(3)), message('a', at(1)), message('b', at(2))],
      OPTIONS,
    )!;
    expect(entryLines(digest.body).map((l) => /summary="msg (\w)"/.exec(l)![1])).toEqual(['a', 'b', 'c']);
  });

  it('keeps the input (arrival) order for equal timestamps; the id never breaks a tie', () => {
    const digest = composePausedDigest(
      [message('b', at(1)), message('a', at(1)), message('c', at(0))],
      OPTIONS,
    )!;
    expect(entryLines(digest.body).map((l) => /summary="msg (\w)"/.exec(l)![1])).toEqual(['c', 'b', 'a']);
  });

  it('renders each entry with its ORIGINAL timestamp, not the digest time', () => {
    const digest = composePausedDigest([message('a', '2026-10-24T01:00:07.000Z')], OPTIONS)!;
    const [line] = entryLines(digest.body);
    expect(line).toContain('timestamp=2026-10-24T01:00:07.000Z');
    expect(line.match(/timestamp=/g)).toHaveLength(1);
  });

  it('renders an entry exactly as buildPtyNotificationText does with the timestamp override', () => {
    const entry = processEntry('p1', at(5));
    const digest = composePausedDigest([entry], OPTIONS)!;
    expect(entryLines(digest.body)).toEqual([
      buildPtyNotificationText({ ...entry.params, timestamp: at(5) }).trimStart(),
    ]);
  });

  it('adds a reply hint to a message entry with a sender, and to nothing else', () => {
    const digest = composePausedDigest(
      [message('a', at(1)), processEntry('p', at(2))],
      OPTIONS,
    )!;
    const [msgLine, procLine] = entryLines(digest.body);
    expect(msgLine).toContain('reply: send_session_message toSessionId="sender-1"');
    expect(procLine).not.toContain('reply:');
  });

  it('gives the reply hint to internal-message only, even if another kind row carries a reply_to', () => {
    const digest = composePausedDigest([{ ...processEntry('p', at(2)), replyToSessionId: 'sender-1' }], OPTIONS)!;
    expect(digest.body).not.toContain('reply:');
  });

  it('omits the reply hint when the sender session was deleted (reply_to NULL)', () => {
    const digest = composePausedDigest([message('a', at(1), { replyToSessionId: null })], OPTIONS)!;
    expect(digest.body).not.toContain('reply:');
    expect(digest.body).not.toContain('send_session_message');
  });

  it('shows a nested digest entry with its path and without its stored body', () => {
    const nested: PausedDigestEntry = {
      id: 'd1',
      workerId: 'w1',
      kind: 'internal-paused-digest',
      params: {
        kind: 'internal-paused-digest',
        tag: 'internal:paused-digest',
        fields: {
          pausedAt: at(0),
          resumedAt: at(1),
          count: '2',
          omitted: '0',
          path: '/data/deferred/earlier.md',
          summary: '2 notifications arrived while paused',
        },
        intent: 'triage',
        body: 'STORED BODY MUST NOT BE REPEATED',
      },
      sourceId: '/data/deferred/earlier.md',
      replyToSessionId: null,
      createdAt: at(2),
    };
    const digest = composePausedDigest([nested], OPTIONS)!;
    const [line] = entryLines(digest.body);
    expect(line).toContain('[internal:paused-digest]');
    expect(line).toContain('path=/data/deferred/earlier.md');
    expect(digest.body).not.toContain('STORED BODY MUST NOT BE REPEATED');
  });

  it('header fields are all strings and carry the counts, window and path', () => {
    const digest = composePausedDigest([message('a', at(1)), message('b', at(2)), processEntry('c', at(3))], OPTIONS)!;
    expect(digest.kind).toBe('internal-paused-digest');
    expect(digest.tag).toBe('internal:paused-digest');
    expect(digest.intent).toBe('triage');
    expect(digest.fields).toEqual({
      pausedAt: OPTIONS.pausedAt,
      resumedAt: OPTIONS.resumedAt,
      count: '3',
      omitted: '0',
      path: PATH,
      summary: '3 notifications arrived while paused',
    });
    for (const value of Object.values(digest.fields)) expect(typeof value).toBe('string');
  });

  it('states the framing in the body and appends no [Reply Instructions] block', () => {
    const digest = composePausedDigest([message('a', at(1))], OPTIONS)!;
    expect(digest.body.startsWith('These notifications arrived while this session was paused.')).toBe(true);
    expect(digest.body).toContain('Some may need action');
    expect(digest.body).toContain('some may be stale by now');
    expect(digest.body).toContain('some may need confirming with the sender');
    expect(digest.body).toContain('Timers and wakeups were suspended');
    expect(digest.body).not.toContain('[Reply Instructions]');
  });

  it('with short entries that fit the char budget, 51 entries -> 50 shown, omitted=1, the oldest is gone, body starts with the omitted line', () => {
    const entries = Array.from({ length: 51 }, (_, i) => message(`e${String(i).padStart(2, '0')}`, at(i)));
    // The entry cap in isolation: a realistic rendered line is ~175 characters, so the
    // 6000-char budget (tested separately below) binds before 50 entries for such lines.
    const digest = composePausedDigest(entries, { ...OPTIONS, maxChars: Number.MAX_SAFE_INTEGER })!;

    expect(digest.fields.count).toBe('51');
    expect(digest.fields.omitted).toBe('1');
    expect(digest.body.startsWith(`1 older entries omitted, full list at ${PATH}\n`)).toBe(true);
    const lines = entryLines(digest.body);
    expect(lines).toHaveLength(50);
    expect(digest.body).not.toContain('msg e00"');
    expect(lines[0]).toContain('msg e01');
    expect(lines[49]).toContain('msg e50');
  });

  it('exactly 50 entries -> nothing omitted and no omitted line', () => {
    const entries = Array.from({ length: 50 }, (_, i) => message(`e${i}`, at(i)));
    const digest = composePausedDigest(entries, { ...OPTIONS, maxChars: Number.MAX_SAFE_INTEGER })!;
    expect(digest.fields.omitted).toBe('0');
    expect(digest.body).not.toContain('older entries omitted');
    expect(entryLines(digest.body)).toHaveLength(50);
  });

  it('the 6000-char budget drops the OLDEST entries and keeps the newest', () => {
    const long = 'x'.repeat(400);
    const entries = Array.from({ length: 30 }, (_, i) => message(`e${String(i).padStart(2, '0')}`, at(i), {}, `${long} ${String(i).padStart(2, '0')}`));
    const digest = composePausedDigest(entries, OPTIONS)!;

    expect(digest.body.length).toBeLessThanOrEqual(6000);
    const omitted = Number(digest.fields.omitted);
    expect(omitted).toBeGreaterThan(0);
    expect(omitted).toBeLessThan(30);
    expect(digest.body.startsWith(`${omitted} older entries omitted, full list at ${PATH}\n`)).toBe(true);
    const shown = entryLines(digest.body);
    expect(shown).toHaveLength(30 - omitted);
    expect(shown[shown.length - 1]).toContain(`${long} 29`);
    expect(digest.body).not.toContain(`${long} 00`);
    // The cut is minimal: one more entry would not have fit.
    const oneMore = composePausedDigest(entries, { ...OPTIONS, maxEntries: 30 - omitted + 1, maxChars: Number.MAX_SAFE_INTEGER })!;
    expect(oneMore.body.length).toBeGreaterThan(6000);
  });

  it('at a typical ~175-char rendered entry the char budget binds before the 50-entry cap', () => {
    const TARGET = 175;
    const renderedLength = (summary: string): number => {
      const probe = composePausedDigest([message('e00', at(0), {}, summary)], { ...OPTIONS, maxChars: Number.MAX_SAFE_INTEGER })!;
      return entryLines(probe.body)[0]!.length;
    };
    // Size the content field from a measured empty-summary rendering, then re-measure the result.
    const summary = 'y'.repeat(TARGET - renderedLength(''));
    const perEntry = renderedLength(summary);
    expect(perEntry).toBe(TARGET);

    const total = 50;
    const entries = Array.from({ length: total }, (_, i) => message(`e${String(i).padStart(2, '0')}`, at(i), {}, summary));
    const digest = composePausedDigest(entries, OPTIONS)!;

    // Expected count from the measured sizes: framing line + omitted line + N * (newline + entry) <= maxChars.
    const framingLength = composePausedDigest([entries[0]!], OPTIONS)!.body.split('\n')[0]!.length;
    const omittedLineLength = `10 older entries omitted, full list at ${PATH}`.length;
    const fit = Math.floor((OPTIONS.maxChars - omittedLineLength - 1 - framingLength) / (perEntry + 1));
    const expectedOmitted = total - fit;

    expect(expectedOmitted).toBeGreaterThanOrEqual(10);
    expect(expectedOmitted).toBeLessThan(100);
    expect(Number(digest.fields.omitted)).toBe(expectedOmitted);
    // The budget, not the cap, decided: more than 0 omitted although 50 entries are within maxEntries.
    expect(total).toBeLessThanOrEqual(OPTIONS.maxEntries);
    expect(entryLines(digest.body)).toHaveLength(fit);
    expect(fit).toBeLessThan(50);
    expect(digest.body.length).toBeLessThanOrEqual(OPTIONS.maxChars);
  });

  it('when even the newest entry cannot fit, none is shown and all are counted as omitted', () => {
    const digest = composePausedDigest([message('a', at(1))], { ...OPTIONS, maxChars: 50 })!;
    expect(digest.fields.omitted).toBe('1');
    expect(entryLines(digest.body)).toHaveLength(0);
  });
});

describe('composeDeferredReadMore', () => {
  it('lists every entry untruncated, grouped by worker, chronological within each', () => {
    const entries: PausedDigestEntry[] = [
      message('a', at(1), { workerId: 'w1' }),
      message('b', at(2), { workerId: 'w2' }),
      message('c', at(3), { workerId: 'w1' }),
      ...Array.from({ length: 60 }, (_, i) => processEntry(`p${String(i).padStart(2, '0')}`, at(10 + i))),
    ];
    const text = composeDeferredReadMore(entries, OPTIONS);

    expect(text).toContain('count: 63');
    expect(text).toContain(`pausedAt: ${OPTIONS.pausedAt}`);
    expect(text).toContain(`resumedAt: ${OPTIONS.resumedAt}`);
    expect(text.match(/^- /gm)).toHaveLength(63);
    expect(text.indexOf('## Worker w1')).toBeLessThan(text.indexOf('## Worker w2'));
    const w1 = text.slice(text.indexOf('## Worker w1'), text.indexOf('## Worker w2'));
    expect(w1.indexOf('msg a')).toBeLessThan(w1.indexOf('msg c'));
    expect(w1).not.toContain('msg b');
    // Same per-entry rendering as the digest, reply hint included.
    expect(text).toContain(`- ${composePausedDigest([entries[0]!], OPTIONS)!.body.split('\n').pop()}`);
  });
});
