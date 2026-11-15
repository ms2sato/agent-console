import { describe, it, expect } from 'bun:test';
import {
  projectSlackContent,
  sanitizeMultiline,
  toSingleLine,
  SLACK_CONTENT_MAX_BYTES,
} from '../slack-content.js';
// Fictional values from a public repository's sender fixture (see slack-blocks-golden.json).
import golden from './fixtures/slack-blocks-golden.json';

const HEADING = '## Content';
const NOTE =
  'Slack mrkdwn, verbatim. &lt; &gt; &amp; are escaped characters; <!channel>, <@U...> and <url|label> are Slack tokens.';
const CUT = `(Content cut at ${SLACK_CONTENT_MAX_BYTES} bytes.)`;
const SENDER = '(The sender shortened the Slack message to fit its size limit; content may be missing.)';

const sectionOf = (message: Record<string, unknown> | undefined, truncated = false): string | null => {
  const projection = projectSlackContent(message, truncated);
  return projection.section === null ? null : projection.section.join('\n');
};
const section = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'section', text: { type: 'mrkdwn', text }, ...extra });
const withNote = (...rest: string[]) => [HEADING, '', NOTE, ...rest].join('\n');

describe('projectSlackContent: golden', () => {
  const GOLDEN_EXPECTED = [
    HEADING,
    '',
    NOTE,
    '',
    '<!channel>',
    '',
    '### 🚨 arata daily — acme',
    '',
    '*期間* 10/20 09:00 〜 10/21 09:00 (UTC)',
    '*新規* 🚨 critical 1 ・ 🟠 medium 2',
    '変化 1 件 ・ 再発 1 件',
    '解消 1 件 ・ 未対応 1 件',
    '本日報告済み 1 件',
    '情報 1 件 (件数のみ)',
    '',
    'まず対応 3 件 (最も重いのは「summary of arn:aws:iam::1:root|203.0.113.1」)、確認推奨 2 件。',
    '',
    '⚠️ *取れていないもの* (結果が欠けている可能性があります)',
    '*取れなかったソース*',
    '• trail-us: `QUERY_LIMIT` 取れた期間 2026-10-20T20:00:00Z 〜 2026-10-21T09:00:00Z',
    '*形式の解釈率の警告*',
    '• app (json): 解釈率 0.50、閾値 0.40 `FORMAT_DRIFT`',
    '*スキップしたチェック*: login_bruteforce (no http_access source)',
    '',
    '---',
    '',
    '*まず対応*',
    '',
    '🚨 *summary of arn:aws:iam::1:root|203.0.113.1* `id: f-002`',
    '→ 封じ込め (侵害の疑い): ルートのパスワードを変える、ルートのアクセスキーがあれば無効化・削除する',
    '',
    '🚨 *summary of arn:aws:iam::1:root|192.0.2.1* (再発) `id: f-009`',
    '→ 封じ込め (侵害の疑い): ルートのパスワードを変える、ルートのアクセスキーがあれば無効化・削除する',
    '',
    '🔴 *summary of a-&gt;b* (変化) `id: f-003`',
    '→ 封じ込め (侵害の疑い): ロールの信頼ポリシーから不審な主体を外す',
    '',
    '---',
    '',
    '*確認推奨*',
    '',
    '🟠 *summary of 198.51.100.7* `id: f-010`',
    '',
    '🟠 *summary of arn:aws:iam::1:user/x* `id: f-001`',
    '',
    '全文と対処手順: `arata review` ・ `arata help ai playbook <check>`',
    '<dir>/report.md',
  ].join('\n');

  it('renders the whole report in the sender order as one exact section', () => {
    const projection = projectSlackContent(golden.slack_message, false);
    expect(projection.section?.join('\n')).toBe(GOLDEN_EXPECTED);
    expect(projection.counts).toEqual({ blocksSeen: 15, attachmentsSeen: 0, chunks: 15, notShown: 0, cut: false });
    expect(projection.firstLine).toBe('<!channel>');
    // The fixed reading note itself says "verbatim"; the sender's keys are what must be absent.
    const projected = (projection.section ?? []).filter((line) => line !== NOTE).join('\n');
    for (const forbidden of ['block_id', 'verbatim', 'emoji', 'unfurl']) {
      expect(projected).not.toContain(forbidden);
    }
  });
});

describe('projectSlackContent: no section', () => {
  it('(a) renders nothing for absent, empty or wrongly typed arrays', () => {
    for (const message of [undefined, {}, { blocks: [] }, { blocks: 'x' }, { attachments: {} }]) {
      const projection = projectSlackContent(message, false);
      expect(projection.section).toBeNull();
      expect(projection.firstLine).toBeNull();
    }
  });

  it('(f) ignores rich_text without counting it', () => {
    const only = projectSlackContent({ blocks: [{ type: 'rich_text', elements: [{ type: 'text', text: 'dup' }] }] }, false);
    expect(only.section).toBeNull();
    expect(only.counts).toEqual({ blocksSeen: 1, attachmentsSeen: 0, chunks: 0, notShown: 0, cut: false });

    const mixed = projectSlackContent({ blocks: [{ type: 'rich_text', elements: [] }, section('hello')] }, false);
    expect(mixed.section?.join('\n')).toBe(withNote('', 'hello'));
    expect(mixed.counts.notShown).toBe(0);
  });

  it('(e) renders a divider alone as the section, never counted, with no first line', () => {
    const projection = projectSlackContent({ blocks: [{ type: 'divider' }] }, false);
    expect(projection.section?.join('\n')).toBe(withNote('', '---'));
    expect(projection.counts).toMatchObject({ chunks: 1, notShown: 0 });
    expect(projection.firstLine).toBeNull();
  });

  it('never throws, whatever the input shape', () => {
    const throwing = (key: string) => Object.defineProperty({}, key, { enumerable: true, get: () => { throw new Error('boom'); } });
    const inputs: Array<Record<string, unknown> | undefined> = [
      undefined,
      {},
      { blocks: [null, 7, 'x', [], {}, { type: null }, { type: 'section', text: 5, fields: 'x' }] },
      { attachments: [null, 7, 'x', [], {}, { fields: [null, 3, { title: 5 }], blocks: 'x' }] },
      { blocks: { length: 3 }, attachments: 'x' },
      throwing('blocks') as Record<string, unknown>,
      throwing('attachments') as Record<string, unknown>,
      { blocks: [throwing('type')] },
      { attachments: [throwing('title')] },
    ];
    for (const input of inputs) {
      expect(() => projectSlackContent(input, false)).not.toThrow();
      expect(() => projectSlackContent(input, true)).not.toThrow();
    }
  });
});

describe('projectSlackContent: blocks', () => {
  it('(b) renders a header on one line, and counts a header without a text object', () => {
    const ok = projectSlackContent({ blocks: [{ type: 'header', text: { type: 'plain_text', text: 'Title' } }] }, false);
    expect(ok.section?.join('\n')).toBe(withNote('', '### Title'));

    const bad = projectSlackContent({ blocks: [{ type: 'header', text: { text: 5 } }] }, false);
    expect(bad.section?.join('\n')).toBe(withNote('', '(1 block without projectable text not shown.)'));
    expect(bad.counts.notShown).toBe(1);
    expect(bad.firstLine).toBeNull();
  });

  it('(c) renders a section with text only, fields only, both, and counts neither', () => {
    const f = (text: string) => ({ type: 'mrkdwn', text });
    expect(sectionOf({ blocks: [section('T')] })).toBe(withNote('', 'T'));
    expect(sectionOf({ blocks: [{ type: 'section', fields: [f('F1'), f('F2')] }] })).toBe(withNote('', 'F1', 'F2'));
    expect(sectionOf({ blocks: [section('T', { fields: [f('F1'), 5, f('F2')] })] })).toBe(withNote('', 'T', 'F1', 'F2'));
    const neither = projectSlackContent({ blocks: [{ type: 'section' }] }, false);
    expect(neither.section?.join('\n')).toBe(withNote('', '(1 block without projectable text not shown.)'));
    expect(neither.counts.notShown).toBe(1);
  });

  it('counts a section whose text is only whitespace as not shown', () => {
    const projection = projectSlackContent({ blocks: [section('  \n\t ')] }, false);
    expect(projection.counts).toMatchObject({ blocksSeen: 1, chunks: 0, notShown: 1 });
    expect(projection.section?.join('\n')).toBe(withNote('', '(1 block without projectable text not shown.)'));
  });

  it('drops a blank field from a section without leaving an empty line between the real ones', () => {
    const f = (text: string) => ({ type: 'mrkdwn', text });
    const projection = projectSlackContent({ blocks: [{ type: 'section', fields: [f('F1'), f('   '), f('F2')] }] }, false);
    expect(projection.section?.join('\n')).toBe(withNote('', 'F1', 'F2'));
    expect(projection.counts.notShown).toBe(0);
  });

  it('counts a header whose text is only whitespace as not shown', () => {
    const projection = projectSlackContent({ blocks: [{ type: 'header', text: { type: 'plain_text', text: '   ' } }] }, false);
    expect(projection.counts).toMatchObject({ blocksSeen: 1, chunks: 0, notShown: 1 });
    expect(projection.section?.join('\n')).toBe(withNote('', '(1 block without projectable text not shown.)'));
    expect(projection.firstLine).toBeNull();
  });

  it('(d) renders only the text elements of a context block', () => {
    const output = sectionOf({
      blocks: [{
        type: 'context',
        elements: [
          { type: 'image', image_url: 'https://img.example/IMG-SENTINEL.png', alt_text: 'ALT-SENTINEL' },
          { type: 'mrkdwn', text: 'ctx one' },
          { type: 'plain_text', text: 'ctx two' },
        ],
      }],
    });
    expect(output).toBe(withNote('', 'ctx one', 'ctx two'));
    expect(output).not.toContain('IMG-SENTINEL');
    expect(output).not.toContain('ALT-SENTINEL');
    expect(sectionOf({ blocks: [{ type: 'context', elements: [{ type: 'image', alt_text: 'x' }] }] })).toBe(
      withNote('', '(1 block without projectable text not shown.)'),
    );
  });

  it('(g) counts unknown types, a block without a type and non-object entries, with singular and plural wording', () => {
    for (const entry of [{ type: 'image', image_url: 'u' }, { text: { text: 'no type' } }, null, 7, 'x', []]) {
      const projection = projectSlackContent({ blocks: [entry] }, false);
      expect(projection.counts).toMatchObject({ blocksSeen: 1, notShown: 1, chunks: 0 });
      expect(projection.section?.join('\n')).toBe(withNote('', '(1 block without projectable text not shown.)'));
    }
    const two = projectSlackContent({ blocks: [{ type: 'image' }, null] }, false);
    expect(two.counts.notShown).toBe(2);
    expect(two.section?.join('\n')).toBe(withNote('', '(2 blocks without projectable text not shown.)'));
  });

  it('(h) isolates a malformed block between two good ones', () => {
    const throwingBlock = Object.defineProperty({}, 'type', { enumerable: true, get: () => { throw new Error('boom'); } });
    for (const bad of [{ type: 5 }, throwingBlock]) {
      const projection = projectSlackContent({ blocks: [section('first'), bad, section('second')] }, false);
      expect(projection.section?.join('\n')).toBe(withNote('', 'first', '', 'second', '', '(1 block without projectable text not shown.)'));
      expect(projection.counts).toMatchObject({ blocksSeen: 3, chunks: 2, notShown: 1 });
    }
  });

  it('(j) strips control characters but keeps newline and tab; a header collapses to one line', () => {
    const output = sectionOf({
      blocks: [section('a\u001b[31mb\u0000c\u009bd\re\u000bv\u000cw\nf\tg'), { type: 'header', text: { text: 'h1\nh2\u0007\th3\u000b\u000ch4' } }],
    });
    expect(output).toBe(withNote('', 'a[31mbcdevw\nf\tg', '', '### h1 h2 h3 h4'));
    expect(output).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it('(j) renders the exact vertical tab, form feed and CR input as abcd, newline, e, tab, f', () => {
    expect(sectionOf({ blocks: [section('a\u000bb\u000cc\rd\ne\tf')] })).toBe(withNote('', 'abcd\ne\tf'));
  });

  it('(k) keeps mrkdwn tokens and entities byte for byte', () => {
    const text = '&lt;b&gt; &amp; <https://e.example|label> <!here> <@U1>';
    expect(sectionOf({ blocks: [section(text)] })).toBe(withNote('', text));
  });

  it('keeps no key other than the listed text positions', () => {
    const output = sectionOf({
      text: 'TOP-TEXT-SENTINEL',
      user: 'U-SENTINEL',
      blocks: [section('shown', { block_id: 'BID-SENTINEL', accessory: { type: 'image', image_url: 'ACC-SENTINEL' } })],
    });
    expect(output).toBe(withNote('', 'shown'));
  });
});

describe('projectSlackContent: legacy attachments', () => {
  it('(i) renders pretext, title, text and fields; never footer', () => {
    const output = sectionOf({
      attachments: [{
        pretext: 'PRE',
        title: 'TITLE',
        text: 'BODY',
        fields: [{ title: 'k', value: 'v' }, { title: 'only-title' }, { value: 'only-value' }, { short: true }],
        footer: 'FOOTER-SENTINEL',
        author_name: 'AUTHOR-SENTINEL',
        color: '#ff0000',
      }],
    });
    expect(output).toBe(withNote('', 'PRE', 'TITLE', 'BODY', 'k: v', 'only-title', 'only-value'));
  });

  it('(i) uses fallback only when nothing else yields text', () => {
    expect(sectionOf({ attachments: [{ fallback: 'FB' }] })).toBe(withNote('', 'FB'));
    expect(sectionOf({ attachments: [{ text: 'T', fallback: 'FB-SENTINEL' }] })).toBe(withNote('', 'T'));
  });

  it('(i) renders nested blocks by the block rows, after the attachment own fields', () => {
    const output = sectionOf({
      attachments: [{ title: 'T', blocks: [{ type: 'header', text: { text: 'H' } }, section('S'), { type: 'divider' }, { type: 'image' }] }],
    });
    expect(output).toBe(withNote('', 'T', '### H', 'S', '---', '', '(1 block without projectable text not shown.)'));
  });

  it('(i) counts an empty attachment and renders blocks before attachments', () => {
    const projection = projectSlackContent({ attachments: [{}, { text: 'A1' }], blocks: [section('B1')] }, false);
    expect(projection.section?.join('\n')).toBe(withNote('', 'B1', '', 'A1', '', '(1 block without projectable text not shown.)'));
    expect(projection.counts).toEqual({ blocksSeen: 1, attachmentsSeen: 2, chunks: 2, notShown: 1, cut: false });
  });
});

describe('projectSlackContent: nested not-shown counting', () => {
  it('counts an attachment with only unprojectable nested blocks once, and each one next to its own text', () => {
    const nested = [{ type: 'image' }, { type: 'actions' }];
    const alone = projectSlackContent({ attachments: [{ blocks: nested }] }, false);
    expect(alone.counts).toMatchObject({ attachmentsSeen: 1, chunks: 0, notShown: 1 });
    const withText = projectSlackContent({ attachments: [{ text: 't', blocks: nested }] }, false);
    expect(withText.counts).toMatchObject({ attachmentsSeen: 1, chunks: 1, notShown: 2 });
  });
});

describe('projectSlackContent: cap', () => {
  const textBytes = (value: string) => Buffer.byteLength(value, 'utf8');
  const contentOf = (projection: ReturnType<typeof projectSlackContent>): string => {
    const lines = projection.section ?? [];
    return lines.slice(4).filter((line) => line !== CUT).join('\n').trimEnd();
  };

  it('(l) does not cut exactly at the cap and cuts one byte over', () => {
    const exact = projectSlackContent({ blocks: [section('a'.repeat(SLACK_CONTENT_MAX_BYTES))] }, false);
    expect(exact.counts.cut).toBe(false);
    expect(exact.section).not.toContain(CUT);
    expect(contentOf(exact)).toBe('a'.repeat(SLACK_CONTENT_MAX_BYTES));

    const over = projectSlackContent({ blocks: [section('a'.repeat(SLACK_CONTENT_MAX_BYTES + 1))] }, false);
    expect(over.counts.cut).toBe(true);
    expect(over.section).toContain(CUT);
    expect(contentOf(over)).toBe('a'.repeat(SLACK_CONTENT_MAX_BYTES));
  });

  it('(l) drops a 4-byte code point that straddles the cap whole, leaving valid UTF-8', () => {
    for (const [filler, tail] of [[SLACK_CONTENT_MAX_BYTES - 1, '😀'], [SLACK_CONTENT_MAX_BYTES - 3, '😀'], [SLACK_CONTENT_MAX_BYTES - 1, 'é']] as const) {
      const projection = projectSlackContent({ blocks: [section('a'.repeat(filler) + tail)] }, false);
      expect(projection.counts.cut).toBe(true);
      const kept = contentOf(projection);
      expect(kept).toBe('a'.repeat(filler));
      expect(kept).not.toContain('�');
      expect(textBytes(kept)).toBeLessThanOrEqual(SLACK_CONTENT_MAX_BYTES);
      const whole = (projection.section ?? []).join('\n');
      expect(Buffer.from(whole).toString()).toBe(whole);
      expect(whole).not.toContain('�');
    }
  });

  it('(l) keeps a 4-byte code point that ends exactly at the cap', () => {
    const projection = projectSlackContent({ blocks: [section('a'.repeat(SLACK_CONTENT_MAX_BYTES - 4) + '😀')] }, false);
    expect(projection.counts.cut).toBe(false);
    expect(contentOf(projection).endsWith('😀')).toBe(true);
  });

  it('(l) measures bytes, not UTF-16 length', () => {
    // 21846 three-byte characters = 65538 bytes but only 21846 UTF-16 units.
    const projection = projectSlackContent({ blocks: [section('あ'.repeat(21846))] }, false);
    expect(projection.counts.cut).toBe(true);
    expect(contentOf(projection)).toBe('あ'.repeat(21845));
  });
});

describe('projectSlackContent: sender truncation and notices', () => {
  it('(m) renders the section with only the sender line when the flag is set', () => {
    for (const message of [undefined, {}]) {
      const projection = projectSlackContent(message, true);
      expect(projection.section?.join('\n')).toBe(withNote('', SENDER));
      expect(projection.counts).toMatchObject({ chunks: 0, notShown: 0, cut: false });
    }
    expect(sectionOf({ blocks: [section('x')] }, true)).toBe(withNote('', 'x', '', SENDER));
    expect(sectionOf(undefined, false)).toBeNull();
  });

  it('(n) orders the cut, count and sender notices after the content', () => {
    const projection = projectSlackContent({ blocks: [section('a'.repeat(SLACK_CONTENT_MAX_BYTES + 1)), { type: 'image' }] }, true);
    const lines = projection.section ?? [];
    const tail = lines.slice(-6);
    expect(tail).toEqual(['', CUT, '', '(1 block without projectable text not shown.)', '', SENDER]);
  });
});

describe('projectSlackContent: firstLine', () => {
  it('(o) skips dividers and the fixed line, and drops the header prefix', () => {
    expect(projectSlackContent({ blocks: [{ type: 'divider' }, section('first\nsecond')] }, false).firstLine).toBe('first');
    expect(projectSlackContent({ blocks: [{ type: 'header', text: { text: 'Head' } }, section('later')] }, false).firstLine).toBe('Head');
    expect(projectSlackContent({ blocks: [{ type: 'image' }] }, false).firstLine).toBeNull();
    expect(projectSlackContent({ attachments: [{ title: 'AT' }] }, false).firstLine).toBe('AT');
  });
});

describe('sanitizers', () => {
  it('toSingleLine collapses whitespace and strips controls', () => {
    expect(toSingleLine('  a\u001b b\n\tc  ')).toBe('a b c');
    expect(toSingleLine('')).toBe('');
  });

  it('sanitizeMultiline keeps newline and tab, drops CR and other controls', () => {
    expect(sanitizeMultiline('a\r\nb\tc\u0000d')).toBe('a\nb\tcd');
    expect(sanitizeMultiline('a\u000bb\u000cc')).toBe('abc');
    expect(sanitizeMultiline('a\u000bb\u000cc\rd\ne\tf')).toBe('abcd\ne\tf');
  });
});
