import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  ALLOWLISTED_TERMS,
  buildDefinedSet,
  checkGlossaryTerms,
  extractTerminologyTerms,
  normalizeTerm,
  parseGlossaryEntries,
} from '../check-glossary-terms.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-glossary-terms.mjs');

let tempDir;

function write(relPath, content) {
  const full = join(tempDir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function glossary(body) {
  write('docs/glossary.md', `# Glossary\n\n## Core\n\n${body}\n`);
}

function designDoc(name, body) {
  write(`docs/design/${name}.md`, body);
}

function run(options = {}) {
  return checkGlossaryTerms({ cwd: tempDir, ...options });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'glossary-terms-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// Polarity notes (measured by mutating check-glossary-terms.mjs, restored after):
// each test names the mutation that makes it fail.

describe('checkGlossaryTerms: class A (Terminology terms)', () => {
  it('does not treat a glossary heading that merely CONTAINS the term (or is contained by it) as a definition', () => {
    // Mutation: replace `defined.has(normalizeTerm(term))` with a substring test,
    // `[...defined].some((d) => d.includes(key) || key.includes(d))`, and both
    // violations disappear; this test fails (measured; the other 18 tests stay green under it).
    glossary('### SharedSession\nA shared session is accessed by all users (prose mentioning "shared session").');
    designDoc('d', '# D\n\n## Terminology\n\n- **Shared session**: spaced spelling.\n- **Session**: a substring of the heading.\n');
    const { violations } = run();
    expect(violations.map((v) => `${v.file}:${v.line} ${v.term}`)).toEqual([
      'docs/design/d.md:5 Shared session',
      'docs/design/d.md:6 Session',
    ]);
  });

  it('matches the Terminology heading exactly: bullets under `## Terminology notes` are ignored', () => {
    // Mutation: `/^## Terminology\s*$/` -> `/^## Terminology/` makes the Ghost bullet a violation.
    glossary('### Alpha\nAn alpha.');
    designDoc('d', '## Terminology notes\n\n- **Ghost**: not in the Terminology section.\n');
    expect(run().violations).toEqual([]);
  });

  it('reports a Terminology bullet with no glossary entry, naming file:line', () => {
    // Mutation: `if (defined.has(...)) continue;` -> `continue;` makes this fail (no violation).
    glossary('### Alpha\nAn alpha.');
    designDoc('d', '# D\n\n## Terminology\n\n- **Alpha**: defined.\n- **Beta**: missing.\n');
    const { violations } = run();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: 'docs/design/d.md', line: 6, term: 'Beta' });
  });

  it('accepts a term defined only via an Aliases value', () => {
    // Mutation: drop the alias loop in buildDefinedSet -> a violation appears.
    glossary('### Alpha\nAn alpha.\n- **Aliases:** Beta, Gamma (informal)');
    designDoc('d', '## Terminology\n\n- **Beta**: via alias.\n- **Gamma**: via alias with a parenthetical.\n');
    expect(run().violations).toEqual([]);
  });

  it('accepts a term defined only via a backticked identifier in a heading', () => {
    // Mutation: drop the extraKeys loop in buildDefinedSet -> a violation appears.
    glossary('### Initial Prompt (Session) — `initialPrompt`, `initialPromptDelivered`\nText.');
    designDoc('d', '## Terminology\n\n- **initialPromptDelivered**: flag.\n- **Initial Prompt**: the heading itself.\n');
    expect(run().violations).toEqual([]);
  });

  it('matches case-insensitively and ignores surrounding quotes and backticks', () => {
    // Mutation: remove .toLowerCase() or the quote strip in normalizeTerm -> a violation appears.
    glossary('### Canonical Path\nText.');
    designDoc('d', '## Terminology\n\n- **"canonical path"**: quoted lowercase.\n- **`Canonical Path`**: backticked.\n');
    expect(run().violations).toEqual([]);
  });

  it('ignores a term-shaped bullet inside a code fence', () => {
    // Mutation: drop the fenceMask check in extractTerminologyTerms -> a violation appears.
    glossary('### Alpha\nAn alpha.');
    designDoc('d', '## Terminology\n\n```md\n- **Ghost**: in a fence.\n```\n- **Alpha**: real.\n');
    expect(run().violations).toEqual([]);
  });

  it('ignores table cells and nested bullets inside the section', () => {
    // Mutation: widen the bullet regex to allow leading indentation, or add a table-row branch -> a violation appears.
    glossary('### Alpha\nAn alpha.');
    designDoc(
      'd',
      '## Terminology\n\n| Term | Meaning |\n|---|---|\n| **Ghost** | in a table |\n\n- **Alpha**: real.\n  - **Nested**: not a term.\n',
    );
    expect(run().violations).toEqual([]);
  });

  it('reads only the Terminology section: a bullet after the next ## heading is ignored', () => {
    // Mutation: never reset inSection on a later `## ` heading -> a violation appears.
    glossary('### Alpha\nAn alpha.');
    designDoc('d', '## Terminology\n\n- **Alpha**: real.\n\n## Other\n\n- **Ghost**: outside the section.\n');
    expect(run().violations).toEqual([]);
  });

  it('treats an empty Terminology section and a doc without one as clean (boundary)', () => {
    // Mutation: reporting when no terms are found (e.g. `terms.length === 0` => violation) makes this fail.
    glossary('### Alpha\nAn alpha.');
    designDoc('empty', '## Terminology\n\n## Next\n');
    designDoc('none', '# No terminology here\n\nJust prose.\n');
    expect(run().violations).toEqual([]);
  });

  it('also extracts `### Term` headings inside the section', () => {
    // Mutation: drop the `### ` branch in extractTerminologyTerms -> no violation is found.
    glossary('### Alpha\nAn alpha.');
    designDoc('d', '## Terminology\n\n### Heading Term\nBody.\n');
    const { violations } = run();
    expect(violations.map((v) => v.term)).toEqual(['Heading Term']);
  });
});

describe('checkGlossaryTerms: class B (glossary self-consistency)', () => {
  it('reports two entries with the same normalised heading (B1)', () => {
    // Mutation: drop the duplicate-heading branch in checkGlossaryConsistency -> no violation.
    glossary('### Alpha\nOne.\n\n### alpha\nTwo.');
    designDoc('d', '# D\n');
    const { violations } = run();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: 'docs/glossary.md', term: 'alpha' });
    expect(violations[0].reason).toContain('duplicate');
  });

  it("reports an alias equal to a DIFFERENT entry's heading (B2)", () => {
    // Mutation: drop the alias-vs-other-heading loop -> no violation.
    glossary('### Alpha\nOne.\n- **Aliases:** Beta\n\n### Beta\nTwo.');
    designDoc('d', '# D\n');
    const { violations } = run();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: 'docs/glossary.md', term: 'Beta' });
  });

  it("exempts an alias equal to its own entry's heading (self-alias)", () => {
    // Mutation: remove the `a.key === e.headingKey` exemption -> a violation appears.
    glossary('### Alpha\nOne.\n- **Aliases:** ALPHA, alpha');
    designDoc('d', '# D\n');
    expect(run().violations).toEqual([]);
  });
});

describe('allowlist', () => {
  it('skips an allowlisted `file :: term` key', () => {
    // Mutation: ignore the `allowed` set -> a violation appears.
    glossary('### Alpha\nAn alpha.');
    designDoc('d', '## Terminology\n\n- **Label**: a naming-convention label.\n');
    const allowlist = [{ key: 'docs/design/d.md :: Label', reason: 'convention label' }];
    expect(run({ allowlist }).violations).toEqual([]);
    expect(run({ allowlist: [] }).violations).toHaveLength(1);
  });

  it('shipped ALLOWLISTED_TERMS: every entry has a non-empty reason', () => {
    for (const entry of ALLOWLISTED_TERMS) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('shipped ALLOWLISTED_TERMS: every key still occurs in its source doc (no dead entries)', () => {
    for (const { key } of ALLOWLISTED_TERMS) {
      const [file, term] = key.split(' :: ');
      const path = join(REPO_ROOT, file);
      expect(existsSync(path)).toBe(true);
      const terms = extractTerminologyTerms(readFileSync(path, 'utf8')).map((t) => t.term);
      expect(terms).toContain(term);
    }
  });
});

describe('helpers', () => {
  it('normalizeTerm cuts at an em dash and a parenthesis', () => {
    expect(normalizeTerm('Engine (embedded-agent) — openai-api / SDK')).toBe('engine');
    expect(normalizeTerm('  `Foo`  ')).toBe('foo');
  });

  it('buildDefinedSet of an empty glossary is empty (boundary)', () => {
    expect(buildDefinedSet(parseGlossaryEntries('')).size).toBe(0);
  });
});

describe('repo-level', () => {
  it('the real tree passes: exit 0 from the CLI', () => {
    const result = spawnSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.stdout + result.stderr).toContain('OK');
    expect(result.status).toBe(0);
  });
});
