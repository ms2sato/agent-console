import { describe, it, expect } from 'bun:test';

import {
  ALLOWLIST,
  FORBIDDEN_TOKENS,
  assertAllowlistValid,
  findViolationsInSource,
  isExcludedFile,
  formatViolation,
  runCheck,
} from '../check-embedded-agent-stdout-writers.mjs';

describe('findViolationsInSource — forbidden token detection (polarity)', () => {
  it('flags a console.info( call in real code, at the correct line:col', () => {
    const source = 'function f() {\n  console.info(\'hi\');\n}\n';
    const hits = findViolationsInSource(source);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toBe('console.info(');
    expect(hits[0].line).toBe(2);
    expect(hits[0].col).toBe(3);
  });

  it('flags console.log(', () => {
    const hits = findViolationsInSource('console.log("x");\n');
    expect(hits.map((h) => h.token)).toContain('console.log(');
  });

  it('flags console.debug(', () => {
    const hits = findViolationsInSource('console.debug("x");\n');
    expect(hits.map((h) => h.token)).toContain('console.debug(');
  });

  it('flags process.stdout.write(', () => {
    const hits = findViolationsInSource('process.stdout.write("x");\n');
    expect(hits.map((h) => h.token)).toContain('process.stdout.write(');
  });

  it('flags Bun.stdout', () => {
    const hits = findViolationsInSource('Bun.stdout.write("x");\n');
    expect(hits.map((h) => h.token)).toContain('Bun.stdout');
  });

  it('every forbidden token in FORBIDDEN_TOKENS trips the detector at least once', () => {
    for (const token of FORBIDDEN_TOKENS) {
      const statement = token.endsWith('(') ? `${token}"x");\n` : `${token}.write("x");\n`;
      const hits = findViolationsInSource(statement);
      expect(hits.map((h) => h.token)).toContain(token);
    }
  });
});

describe('findViolationsInSource — comments and string/template literals are invisible', () => {
  it('does not flag a forbidden token that appears only in a // line comment', () => {
    const hits = findViolationsInSource('// console.info(x) is mentioned here\nconst y = 1;\n');
    expect(hits).toHaveLength(0);
  });

  it('does not flag a forbidden token that appears only in a /* */ block comment', () => {
    const hits = findViolationsInSource('/* console.log(x) explanation */\nconst y = 1;\n');
    expect(hits).toHaveLength(0);
  });

  it('does not flag a forbidden token inside a string literal', () => {
    const hits = findViolationsInSource('const s = "console.info(x)";\n');
    expect(hits).toHaveLength(0);
  });

  it('does not flag a forbidden token inside a no-substitution template literal', () => {
    const hits = findViolationsInSource('const s = `console.info(x)`;\n');
    expect(hits).toHaveLength(0);
  });

  it('does not flag a forbidden token inside the static text of a template literal', () => {
    const hits = findViolationsInSource('const s = `${msg} console.info(`;\n');
    expect(hits).toHaveLength(0);
  });

  it('still flags a forbidden token that appears inside a template interpolation expression', () => {
    // With the AST-node matcher, this passes for a structurally correct
    // reason: the interpolated `${...}` expression is parsed as a real
    // CallExpression whose callee is a real `console.info` PropertyAccessExpression
    // node, indistinguishable from any other call site in the tree. It is
    // NOT "a substring that happened to survive comment/string blanking" —
    // the earlier substring-based implementation passed this same test for
    // that reason, but the AST matcher never blanks or reconstructs text at
    // all; it walks the tree and this node is simply present in it.
    const hits = findViolationsInSource('const s = `value: ${console.info("x")}`;\n');
    expect(hits.map((h) => h.token)).toContain('console.info(');
  });
});

describe('findViolationsInSource — AST-node matching closes the substring-scan evasion gaps (CodeRabbit)', () => {
  it('flags console.log?.(\'x\') — optional chaining on the CALL', () => {
    const hits = findViolationsInSource("console.log?.('x');\n");
    expect(hits.map((h) => h.token)).toContain('console.log(');
  });

  it('flags console.info /* comment */ (\'x\') — a comment between the property access and the call parens', () => {
    const hits = findViolationsInSource("console.info /* debug */ ('x');\n");
    expect(hits.map((h) => h.token)).toContain('console.info(');
  });

  it('flags console\\n  .debug(\'x\') — property access split across a newline', () => {
    const hits = findViolationsInSource("console\n  .debug('x');\n");
    expect(hits.map((h) => h.token)).toContain('console.debug(');
  });

  it("flags console['info']('x') — ElementAccessExpression with a string-literal key", () => {
    const hits = findViolationsInSource("console['info']('x');\n");
    expect(hits.map((h) => h.token)).toContain('console.info(');
  });

  it('flags Bun.stdout.writer() — the sub-chain Bun.stdout is caught even though the full 3-segment chain is not in the table', () => {
    const hits = findViolationsInSource('Bun.stdout.writer();\n');
    expect(hits.map((h) => h.token)).toContain('Bun.stdout');
  });

  it('flags console?.log(\'x\') — optional chaining on the PROPERTY ACCESS', () => {
    const hits = findViolationsInSource("console?.log('x');\n");
    expect(hits.map((h) => h.token)).toContain('console.log(');
  });

  it('flags console?.log?.(\'x\') — optional chaining on BOTH the property access and the call', () => {
    const hits = findViolationsInSource("console?.log?.('x');\n");
    expect(hits.map((h) => h.token)).toContain('console.log(');
  });
});

describe('findViolationsInSource — negative tests (must NOT flag)', () => {
  it('does not flag myLogger.console.log(...) — the chain root is myLogger, not the bare identifier console', () => {
    const hits = findViolationsInSource("myLogger.console.log('x');\n");
    expect(hits).toHaveLength(0);
  });

  it('does not flag myConsole.log(\'x\') — a different root identifier entirely', () => {
    const hits = findViolationsInSource("myConsole.log('x');\n");
    expect(hits).toHaveLength(0);
  });

  it('does not flag console.warn(\'x\') — an allowed console method, not in FORBIDDEN_CHAINS', () => {
    const hits = findViolationsInSource("console.warn('x');\n");
    expect(hits).toHaveLength(0);
  });

  it('does not flag a local variable literally named "stdout" that is unrelated to process.stdout', () => {
    const hits = findViolationsInSource('const stdout = 5;\nconst total = stdout + 1;\n');
    expect(hits).toHaveLength(0);
  });

  it('does not flag a property access named "stdout" whose root is neither process nor Bun', () => {
    // Confirms the match requires BOTH the root identifier AND the segment
    // name -- a segment literally named "stdout" is not, by itself, enough.
    const hits = findViolationsInSource('const obj = { stdout: 1 };\nconst x = obj.stdout;\n');
    expect(hits).toHaveLength(0);
  });

  it("does not flag a computed ElementAccessExpression key -- console[someVar]('x') is out of scope by design", () => {
    const hits = findViolationsInSource("const key = 'info';\nconsole[key]('x');\n");
    expect(hits).toHaveLength(0);
  });

  it('KNOWN LIMITATION: a locally shadowed `console` is still flagged (no scope/shadowing resolution is attempted)', () => {
    // This is a purely syntactic identifier-name match with no scope
    // analysis, so a local variable named `console` that shadows the
    // global is indistinguishable from the real global console. The
    // pre-AST substring matcher had this exact same limitation (it matched
    // on literal text, which also cannot see scope), so this is not a
    // regression introduced by the AST rewrite -- it is confirmed here so
    // the limitation is a documented, empirically-verified fact rather
    // than an unexamined assumption.
    const source = "const console = { log: () => {} };\nconsole.log('x');\n";
    const hits = findViolationsInSource(source);
    expect(hits.map((h) => h.token)).toContain('console.log(');
  });
});

describe('findViolationsInSource — enclosing function name resolution', () => {
  it('resolves the name of a FunctionDeclaration containing the hit', () => {
    const hits = findViolationsInSource('function writeEvent() {\n  process.stdout.write("x");\n}\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].functionName).toBe('writeEvent');
  });

  it('resolves the innermost enclosing function when nested', () => {
    const source = 'function outer() {\n  function inner() {\n    console.log("x");\n  }\n}\n';
    const hits = findViolationsInSource(source);
    expect(hits).toHaveLength(1);
    expect(hits[0].functionName).toBe('inner');
  });

  it('returns null functionName for a top-level hit outside any function', () => {
    const hits = findViolationsInSource('console.log("x");\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].functionName).toBe(null);
  });
});

describe('findViolationsInSource — fail-closed on parse failure', () => {
  it('still flags a forbidden token via the raw-scan fallback on malformed TS', () => {
    const broken = 'function f( {{{ ) unterminated \'string\n  console.log("x");\n';
    const hits = findViolationsInSource(broken);
    expect(hits.map((h) => h.token)).toContain('console.log(');
  });
});

describe('isExcludedFile', () => {
  it('excludes files under a __tests__ directory', () => {
    expect(isExcludedFile('packages/embedded-agent/src/__tests__/foo.ts')).toBe(true);
  });

  it('excludes *.test.ts files', () => {
    expect(isExcludedFile('packages/embedded-agent/src/foo.test.ts')).toBe(true);
  });

  it('does not exclude an ordinary production file', () => {
    expect(isExcludedFile('packages/embedded-agent/src/main.ts')).toBe(false);
  });
});

describe('assertAllowlistValid', () => {
  it('does not throw for the real ALLOWLIST', () => {
    expect(() => assertAllowlistValid(ALLOWLIST)).not.toThrow();
  });

  it('throws when an entry has an empty reason', () => {
    expect(() =>
      assertAllowlistValid([{ file: 'a.ts', functionName: 'f', reason: '' }]),
    ).toThrow(/missing a reason/);
  });

  it('throws when an entry has a whitespace-only reason', () => {
    expect(() =>
      assertAllowlistValid([{ file: 'a.ts', functionName: 'f', reason: '   ' }]),
    ).toThrow(/missing a reason/);
  });

  it('throws when an entry is missing functionName', () => {
    expect(() =>
      assertAllowlistValid([{ file: 'a.ts', reason: 'some reason' }]),
    ).toThrow(/missing file\/functionName/);
  });
});

describe('formatViolation', () => {
  it('formats a non-allowlisted hit without a suffix', () => {
    const line = formatViolation({ file: 'a.ts', line: 3, col: 5, token: 'console.log(', allowlistReason: null });
    expect(line).toBe('a.ts:3:5 console.log(');
  });

  it('formats an allowlisted hit with a truncated reason suffix', () => {
    const longReason = 'x'.repeat(100);
    const line = formatViolation({ file: 'a.ts', line: 3, col: 5, token: 'Bun.stdout', allowlistReason: longReason });
    expect(line).toBe(`a.ts:3:5 Bun.stdout (allowlisted: ${'x'.repeat(60)}...)`);
  });
});

describe('runCheck — allowlist matching by file + enclosing function name', () => {
  it('reports the real allowlisted shape (writeEvent in main.ts) as allowlisted, not a failure', async () => {
    const result = await runCheck({ files: ['packages/embedded-agent/src/main.ts'] });
    expect(result.newViolations).toEqual([]);
    expect(result.allowlisted).toHaveLength(1);
    expect(result.allowlisted[0].token).toBe('process.stdout.write(');
    expect(result.allowlisted[0].allowlistReason).not.toBe(null);
  });

  it('classifies a hit in a differently-named function at the allowlisted file path as a real violation', async () => {
    // Same file path as the allowlist entry, but a DIFFERENT enclosing
    // function name -- must NOT be silently allowlisted by file path alone.
    const source = 'function notWriteEvent() {\n  console.log("x");\n}\n';
    const hits = findViolationsInSource(source);
    expect(hits).toHaveLength(1);
    expect(hits[0].functionName).toBe('notWriteEvent');
    const allowlistEntry = ALLOWLIST.find(
      (e) => e.file === 'packages/embedded-agent/src/main.ts' && e.functionName === 'notWriteEvent',
    );
    expect(allowlistEntry).toBeUndefined();
  });

  it('scans the real repository tree end-to-end and finds zero non-allowlisted violations', async () => {
    const result = await runCheck({});
    expect(result.newViolations).toEqual([]);
    expect(result.allowlisted.length).toBeGreaterThanOrEqual(1);
    expect(
      result.allowlisted.some(
        (v) => v.file === 'packages/embedded-agent/src/main.ts' && v.token === 'process.stdout.write(',
      ),
    ).toBe(true);
  });

  it('excludes __tests__ directories and *.test.ts files from the real repo scan', async () => {
    const result = await runCheck({});
    expect(result.files.every((f) => !f.includes('/__tests__/'))).toBe(true);
    expect(result.files.every((f) => !f.endsWith('.test.ts'))).toBe(true);
  });
});
