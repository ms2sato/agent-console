import { describe, it, expect } from 'bun:test';
import {
  parseCatalog,
  analyzeIssue,
  matchInvariants,
  formatReport,
  MATCHING_RULES,
  loadCatalog,
} from '../suggest-criteria.js';

// --- Fixture helpers ---

function buildCatalogFixture({ withTemplate = true, extraEntry = false } = {}) {
  const template = withTemplate
    ? `\n### Suggested acceptance criterion template\n\n- [ ] Sample criterion for I-1 → integration test\n`
    : '';
  let md = `# Architectural Invariants\n\nIntro text.\n\n---\n\n`;
  md += `## I-1. I/O Addressing Symmetry\n\n**Rule.** ...\n\n### Detection heuristics\n\n1. Grep for pairs.\n${template}\n---\n\n`;
  md += `## I-2. Single Writer for Derived Values\n\n**Rule.** ...\n\n### Detection heuristics\n\n1. Grep for similar expressions.\n\n### Suggested acceptance criterion template\n\n- [ ] Sample I-2 criterion → unit test\n\n---\n\n`;
  if (extraEntry) {
    md += `## I-99. Experimental Entry Without Template\n\n**Rule.** ...\n\n### Detection heuristics\n\n1. Heuristic.\n\n---\n\n`;
  }
  md += `## How to Add New Invariants\n\nformat etc.\n`;
  return md;
}

// --- parseCatalog ---

describe('parseCatalog', () => {
  it('parses each I-N header into a separate entry', () => {
    const entries = parseCatalog(buildCatalogFixture());
    expect(entries.map(e => e.id)).toEqual(['I-1', 'I-2']);
    expect(entries[0].name).toBe('I/O Addressing Symmetry');
    expect(entries[1].name).toBe('Single Writer for Derived Values');
  });

  it('extracts the suggested acceptance criterion template when present', () => {
    const entries = parseCatalog(buildCatalogFixture());
    expect(entries[0].template).toContain('Sample criterion for I-1');
    expect(entries[1].template).toContain('Sample I-2 criterion');
  });

  it('returns null template for entries without the template section', () => {
    const entries = parseCatalog(buildCatalogFixture({ withTemplate: false }));
    expect(entries[0].template).toBeNull();
    // I-2 still has a template in the fixture.
    expect(entries[1].template).toContain('Sample I-2 criterion');
  });

  it('stops at non-invariant top-level sections', () => {
    const entries = parseCatalog(buildCatalogFixture({ extraEntry: true }));
    // Extra "I-99" entry has no template — should still be parsed, template null.
    const ids = entries.map(e => e.id);
    expect(ids).toContain('I-99');
    const i99 = entries.find(e => e.id === 'I-99');
    expect(i99.template).toBeNull();
    // "How to Add New Invariants" is not an I-N entry, so not included.
    expect(ids.every(id => /^I-\d+$/.test(id))).toBe(true);
  });

  it('parses the real catalog without throwing', () => {
    const entries = parseCatalog(loadCatalog());
    expect(entries.length).toBeGreaterThanOrEqual(6);
    for (const entry of entries) {
      expect(entry.id).toMatch(/^I-\d+$/);
      expect(entry.name).toBeTruthy();
    }
    // Every shipped entry should have a suggested template now.
    const withoutTemplate = entries.filter(e => !e.template);
    expect(withoutTemplate).toHaveLength(0);
  });
});

// --- analyzeIssue ---

describe('analyzeIssue', () => {
  it('lowercases the combined title+body for keyword search', () => {
    const analysis = analyzeIssue({
      title: 'feat: Persist Session State',
      body: 'We need to WRITE and READ activity events.',
    });
    expect(analysis.lowered).toContain('persist session state');
    expect(analysis.lowered).toContain('write and read');
  });

  it('extracts affected file paths that appear in the body', () => {
    const analysis = analyzeIssue({
      title: 't',
      body: 'Affected: `packages/server/src/routes/session.ts` and `packages/server/src/database/schema.ts`.',
    });
    expect(analysis.paths).toContain('packages/server/src/routes/session.ts');
    expect(analysis.paths).toContain('packages/server/src/database/schema.ts');
  });

  it('returns empty paths when body mentions no source-tree fragments', () => {
    const analysis = analyzeIssue({
      title: 'docs: update README',
      body: 'Just update the readme and changelog text.',
    });
    expect(analysis.paths).toEqual([]);
  });

  it('handles missing title or body without throwing', () => {
    expect(analyzeIssue({}).text).toBe('\n');
    expect(analyzeIssue({ title: 't' }).lowered).toContain('t');
  });
});

// --- matchInvariants ---

describe('matchInvariants', () => {
  const realCatalog = parseCatalog(loadCatalog());

  it('matches I-1 when the body mentions write + read + session_id', () => {
    const analysis = analyzeIssue({
      title: 'feat: session activity log',
      body: 'We will write events per session_id, then read them back via GET.',
    });
    const matches = matchInvariants(analysis, realCatalog);
    const ids = matches.map(m => m.id);
    expect(ids).toContain('I-1');
    const i1 = matches.find(m => m.id === 'I-1');
    expect(i1.hitKeywords).toEqual(expect.arrayContaining(['write', 'read', 'session_id']));
    expect(i1.template).toBeTruthy();
  });

  it('emits no matches when no catalog keywords or paths appear', () => {
    const analysis = analyzeIssue({
      title: 'docs: tweak copy',
      body: 'Polish the landing copy for tone consistency.',
    });
    const matches = matchInvariants(analysis, realCatalog);
    expect(matches).toEqual([]);
  });

  it('matches I-5 when localStorage is mentioned', () => {
    const analysis = analyzeIssue({
      title: 'feat: remember last tab',
      body: 'Store last selected tab in localStorage so reloads keep it.',
    });
    const matches = matchInvariants(analysis, realCatalog);
    expect(matches.map(m => m.id)).toContain('I-5');
  });

  it('matches I-6 when validation + schema + payload appear', () => {
    const analysis = analyzeIssue({
      title: 'feat: webhook receiver',
      body: 'Parse incoming payload from an external API and validate with a schema.',
    });
    const matches = matchInvariants(analysis, realCatalog);
    expect(matches.map(m => m.id)).toContain('I-6');
  });

  it('skips catalog entries that lack a template', () => {
    const entries = [
      { id: 'I-1', name: 'I/O Addressing Symmetry', template: null },
      { id: 'I-2', name: 'Single Writer', template: '- [ ] x' },
    ];
    const analysis = analyzeIssue({
      title: 't',
      body: 'write read derive compute',
    });
    const matches = matchInvariants(analysis, entries);
    expect(matches.map(m => m.id)).toEqual(['I-2']);
  });

  it('respects a path-only match when no keywords fire', () => {
    const entries = [
      {
        id: 'I-TEST',
        name: 'Path-Only Test',
        template: '- [ ] path-only criterion',
      },
    ];
    const rules = {
      'I-TEST': {
        keywords: ['zzz_never_matches'],
        pathFragments: ['database/'],
        relevance: 'test',
      },
    };
    const analysis = analyzeIssue({
      title: 't',
      body: 'See `packages/server/src/database/schema.ts`.',
    });
    const matches = matchInvariants(analysis, entries, rules);
    expect(matches).toHaveLength(1);
    expect(matches[0].hitKeywords).toEqual([]);
    expect(matches[0].hitPaths).toEqual(['database/']);
  });
});

// --- formatReport ---

describe('formatReport', () => {
  it('prints the "No matches" guidance when no invariants apply', () => {
    const issue = { number: 42, title: 'chore: docs tweak', body: '' };
    const analysis = analyzeIssue(issue);
    const out = formatReport(issue, analysis, []);
    expect(out).toContain('Issue #42');
    expect(out).toContain('No matches');
    expect(out).toContain('architectural-invariants');
  });

  it('renders each matched invariant with signals, relevance, and template', () => {
    const issue = { number: 7, title: 'feat: x', body: 'write and read path' };
    const analysis = analyzeIssue(issue);
    const matches = [
      {
        id: 'I-1',
        name: 'I/O Addressing Symmetry',
        relevance: 'relevance text',
        hitKeywords: ['write', 'read'],
        hitPaths: [],
        template: '- [ ] round-trip criterion',
      },
    ];
    const out = formatReport(issue, analysis, matches);
    expect(out).toContain('[I-1 I/O Addressing Symmetry]');
    expect(out).toContain('keywords: write, read');
    expect(out).toContain('Relevance: relevance text');
    expect(out).toContain('- [ ] round-trip criterion');
    expect(out).toContain('Orchestrator review');
  });

  it('lists affected paths when present', () => {
    const issue = {
      number: 9,
      title: 't',
      body: '`packages/server/src/routes/x.ts`',
    };
    const analysis = analyzeIssue(issue);
    const out = formatReport(issue, analysis, []);
    expect(out).toContain('packages/server/src/routes/x.ts');
  });
});

// --- MATCHING_RULES sanity ---

describe('MATCHING_RULES', () => {
  it('has a rule for every shipped invariant that has a template', () => {
    const catalog = parseCatalog(loadCatalog()).filter(e => e.template);
    for (const entry of catalog) {
      expect(MATCHING_RULES[entry.id]).toBeDefined();
      expect(MATCHING_RULES[entry.id].relevance).toBeTruthy();
    }
  });
});
