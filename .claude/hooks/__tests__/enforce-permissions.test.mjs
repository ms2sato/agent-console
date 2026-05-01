import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '..', 'enforce-permissions.sh');

function runHook(input, { env } = {}) {
  const result = spawnSync('bash', [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, ...(env ?? {}) },
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function decision(stdout) {
  if (!stdout.trim()) return null;
  const parsed = JSON.parse(stdout);
  return parsed?.hookSpecificOutput?.permissionDecision ?? null;
}

function reason(stdout) {
  if (!stdout.trim()) return null;
  const parsed = JSON.parse(stdout);
  return parsed?.hookSpecificOutput?.permissionDecisionReason ?? null;
}

function bashEvent(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}

function fileEvent(tool_name, file_path) {
  return { tool_name, tool_input: { file_path } };
}

describe('enforce-permissions: fail-closed', () => {
  it('exits 2 on empty stdin', () => {
    const r = runHook('');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/empty stdin/);
  });

  it('exits 2 on malformed JSON', () => {
    const r = runHook('not json {{');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/parse failed/);
  });

  it('exits 2 when tool_name is missing', () => {
    const r = runHook({ tool_input: { command: 'ls' } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/tool_name missing/);
  });
});

describe('enforce-permissions: allow path (no rules matched)', () => {
  it.each([
    ['Bash: ls', bashEvent('ls -la')],
    ['Bash: git status', bashEvent('git status')],
    ['Bash: git push feature branch', bashEvent('git push origin feature/foo')],
    ['Bash: git push --force feature branch', bashEvent('git push --force origin feature/main-fix')],
    ['Bash: bun run test', bashEvent('bun run test')],
    ['Bash: gh pr create', bashEvent('gh pr create --title "feat: x" --body "..."')],
    ['Read: source file', fileEvent('Read', '/repo/packages/server/src/foo.ts')],
    ['Write: source file', fileEvent('Write', '/repo/packages/server/src/foo.ts')],
    ['Edit: doc file', fileEvent('Edit', '/repo/docs/glossary.md')],
    ['unknown tool', { tool_name: 'WebFetch', tool_input: {} }],
  ])('%s → allow (exit 0, no decision)', (_label, event) => {
    const r = runHook(event);
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBeNull();
  });
});

describe('enforce-permissions: Bash deny — article-aligned core', () => {
  it.each([
    ['rm -rf /tmp/x', 'rm with recursive/force flag'],
    ['rm -fr /tmp/x', 'rm with recursive/force flag'],
    ['rm --recursive /tmp/x', 'rm with recursive/force flag'],
    ['rm --force foo', 'rm with recursive/force flag'],
    ['sudo whoami', 'sudo'],
    ['ssh user@host', 'ssh'],
    ['dd if=/dev/zero of=/tmp/x bs=1M', 'dd with if=/of='],
    ['kill -9 1234', 'kill -9'],
    ['kill -KILL 1234', 'kill -9'],
  ])('denies: %s', (command, expectedReasonFragment) => {
    const r = runHook(bashEvent(command));
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toContain(expectedReasonFragment);
  });
});

describe('enforce-permissions: Bash deny — bypass detection', () => {
  it("collapses single-quote splitting ('r''m' -rf → rm -rf)", () => {
    const r = runHook(bashEvent("'r''m' -rf /tmp/x"));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('collapses double-quote splitting ("r""m" -rf → rm -rf)', () => {
    const r = runHook(bashEvent('"r""m" -rf /tmp/x'));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('catches xargs rm pipeline (echo /tmp/x | xargs rm -rf)', () => {
    const r = runHook(bashEvent('echo /tmp/x | xargs rm -rf'));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('catches bash -c "rm -rf ..." inner body', () => {
    const r = runHook(bashEvent('bash -c "rm -rf /tmp/x"'));
    expect(decision(r.stdout)).toBe('deny');
  });

  it("catches sh -c 'rm -rf ...' inner body", () => {
    const r = runHook(bashEvent("sh -c 'rm -rf /tmp/x'"));
    expect(decision(r.stdout)).toBe('deny');
  });
});

describe('enforce-permissions: Bash deny — credential files', () => {
  it.each([
    'cat .env',
    'cat .env.production',
    'cp .env /tmp/x',
    'cat ~/.aws/credentials',
    'ls ~/.ssh/',
    'cat ~/.ssh/id_rsa',
    'cat ~/.ssh/id_rsa_personal',
    'cat /Users/foo/cert.pem',
    'tar c ~/.gnupg/',
  ])('denies credential reference: %s', (command) => {
    const r = runHook(bashEvent(command));
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(/credential/);
  });
});

describe('enforce-permissions: Bash deny — this-system specifics', () => {
  it('denies wiping ~/.agent-console/', () => {
    const r = runHook(bashEvent('rm -rf ~/.agent-console/'));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('denies find -delete inside ~/.agent-console/', () => {
    const r = runHook(bashEvent('find ~/.agent-console -name "*.log" -delete'));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('denies direct write to .git/HEAD', () => {
    const r = runHook(bashEvent('echo "ref: refs/heads/x" > .git/HEAD'));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('denies rm inside .git/refs', () => {
    const r = runHook(bashEvent('rm .git/refs/heads/main'));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('denies git push --force to main', () => {
    const r = runHook(bashEvent('git push --force origin main'));
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(/force.*main\/master/);
  });

  it('denies git push -f to master', () => {
    const r = runHook(bashEvent('git push -f origin master'));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('denies git push --force-with-lease to main', () => {
    const r = runHook(bashEvent('git push --force-with-lease origin main'));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('denies git push origin :main (branch deletion)', () => {
    const r = runHook(bashEvent('git push origin :main'));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('allows git push --force to feature/main-fix (last token differs)', () => {
    const r = runHook(bashEvent('git push --force origin feature/main-fix'));
    expect(decision(r.stdout)).toBeNull();
  });
});

describe('enforce-permissions: Read/Write/Edit deny — credential paths', () => {
  it.each([
    ['Read', '/repo/.env'],
    ['Read', '/repo/.env.local'],
    ['Read', '/Users/foo/.aws/credentials'],
    ['Read', '/Users/foo/.ssh/id_rsa'],
    ['Read', '/Users/foo/.ssh/id_rsa.pub'],
    ['Read', '/etc/cert.pem'],
    ['Write', '/repo/.env'],
    ['Edit', '/Users/foo/.ssh/config'],
    ['Edit', '/Users/foo/.gnupg/pubring.kbx'],
  ])('%s %s → deny', (toolName, filePath) => {
    const r = runHook(fileEvent(toolName, filePath));
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(/credential/);
  });
});

describe('enforce-permissions: Read/Write/Edit deny — this-system specifics', () => {
  it('denies Write to *.db', () => {
    const r = runHook(fileEvent('Write', '/repo/data/agent-console.db'));
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(/SQLite/);
  });

  it('allows Read of *.db', () => {
    const r = runHook(fileEvent('Read', '/repo/data/agent-console.db'));
    expect(decision(r.stdout)).toBeNull();
  });

  it('denies Write to .git/refs/heads/main', () => {
    const r = runHook(fileEvent('Write', '/repo/.git/refs/heads/main'));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('denies Edit to .git/HEAD', () => {
    const r = runHook(fileEvent('Edit', '/repo/.git/HEAD'));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('allows Read of .git/HEAD (diagnostics)', () => {
    const r = runHook(fileEvent('Read', '/repo/.git/HEAD'));
    expect(decision(r.stdout)).toBeNull();
  });
});

describe('enforce-permissions: Bash deny — language interpreter bypass', () => {
  // Each interpreter: malicious case (deny) + benign case (allow)
  it.each([
    [
      'python -c (rm -rf in body) → deny',
      `python -c "import os; os.system('rm -rf /tmp/x')"`,
      /rm/,
    ],
    [
      'python3 -c (rm -rf in body) → deny',
      `python3 -c "import os; os.system('rm -rf /tmp/x')"`,
      /rm/,
    ],
    [
      'node -e (rm -rf in body) → deny',
      `node -e "require('child_process').execSync('rm -rf /tmp/x')"`,
      /rm/,
    ],
    [
      'nodejs -e (rm -rf in body) → deny',
      `nodejs -e "require('child_process').execSync('rm -rf /tmp/x')"`,
      /rm/,
    ],
    [
      'perl -e (rm -rf in body) → deny',
      `perl -e "system('rm -rf /tmp/x')"`,
      /rm/,
    ],
    [
      'ruby -e (rm -rf in body) → deny',
      `ruby -e "system('rm -rf /tmp/x')"`,
      /rm/,
    ],
    [
      'lua -e (rm -rf in body) → deny',
      `lua -e "os.execute('rm -rf /tmp/x')"`,
      /rm/,
    ],
  ])('%s', (_label, command, reasonRegex) => {
    const r = runHook(bashEvent(command));
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(reasonRegex);
  });

  it.each([
    ['python -c (benign) → allow', `python -c "import os"`],
    ['python3 -c (benign) → allow', `python3 -c "print('hello')"`],
    ['node -e (benign) → allow', `node -e "console.log('hi')"`],
    ['nodejs -e (benign) → allow', `nodejs -e "console.log('hi')"`],
    ['perl -e (benign) → allow', `perl -e 'print 1+1'`],
    ['ruby -e (benign) → allow', `ruby -e 'puts 1+1'`],
    ['lua -e (benign) → allow', `lua -e "print('hi')"`],
  ])('%s', (_label, command) => {
    const r = runHook(bashEvent(command));
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBeNull();
  });

  // Catastrophic verbs other than rm
  it('denies sudo in python body', () => {
    const r = runHook(
      bashEvent(`python -c "import os; os.system('sudo whoami')"`)
    );
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(/sudo/);
  });

  it('denies ssh in node body', () => {
    const r = runHook(
      bashEvent(`node -e "require('child_process').exec('ssh user@host')"`)
    );
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(/ssh/);
  });

  it('denies dd in ruby body', () => {
    const r = runHook(
      bashEvent(`ruby -e "system('dd if=/dev/zero of=/tmp/x bs=1M')"`)
    );
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(/dd/);
  });

  it('denies kill -9 in perl body', () => {
    const r = runHook(bashEvent(`perl -e "system('kill -9 1234')"`));
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(/kill/);
  });

  // Credential references
  it('denies .env reference in python body', () => {
    const r = runHook(bashEvent(`python -c "open('.env').read()"`));
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(/credential/);
  });

  it('denies ~/.ssh reference in node body', () => {
    const r = runHook(
      bashEvent(`node -e "require('fs').readFileSync('/Users/foo/.ssh/config')"`)
    );
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(/credential/);
  });

  it('denies ~/.aws reference in ruby body', () => {
    const r = runHook(bashEvent(`ruby -e "File.read('/Users/foo/.aws/credentials')"`));
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(/credential/);
  });

  it('denies *.pem reference in lua body', () => {
    const r = runHook(bashEvent(`lua -e "io.open('/etc/cert.pem')"`));
    expect(decision(r.stdout)).toBe('deny');
    expect(reason(r.stdout)).toMatch(/credential/);
  });

  // Boundary cases
  it('allows empty interpreter body (python -c "")', () => {
    const r = runHook(bashEvent(`python -c ""`));
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBeNull();
  });

  it('denies single-quoted interpreter body', () => {
    const r = runHook(bashEvent(`python -c 'import os; os.system("rm -rf /tmp/x")'`));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('denies double-quoted interpreter body', () => {
    const r = runHook(bashEvent(`python -c "import os; os.system('rm -rf /tmp/x')"`));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('denies leading whitespace before interpreter body', () => {
    const r = runHook(bashEvent(`python -c    "rm -rf /tmp/x"`));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('denies escaped quotes inside interpreter body (caught via original CMD haystack)', () => {
    // Body extraction may truncate at the escape sequence, but the
    // dangerous pattern still appears literally in the original CMD.
    const r = runHook(bashEvent(`python -c "import os; os.system(\\"rm -rf /tmp/x\\")"`));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('denies bash -c wrapping a python interpreter call', () => {
    const r = runHook(bashEvent(`bash -c 'python -c "rm -rf /tmp/x"'`));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('denies quote-split rm inside interpreter body', () => {
    // Quote-splitting normalisation makes 'r''m' collapse to rm before scan.
    const r = runHook(bashEvent(`python -c "import os; os.system('r''m -rf /tmp/x')"`));
    expect(decision(r.stdout)).toBe('deny');
  });

  it('does not over-trigger on benign substring "rm" inside interpreter body', () => {
    // "form" contains "rm" but is not a standalone rm verb; word-boundary
    // matching in the existing regex prevents false positives.
    const r = runHook(bashEvent(`python -c "form = 'submit'"`));
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBeNull();
  });

  it('does not over-trigger on a benign python call referencing innocuous strings', () => {
    const r = runHook(bashEvent(`python -c "print('rm-rf is just a string here')"`));
    // "rm-rf" lacks a space between "rm" and "-rf", so the regex which
    // requires \brm[[:space:]]+- does not fire. This documents the
    // deliberate non-match.
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBeNull();
  });

  it('denies POSIX $\'...\' ANSI-C-quoted body via original-CMD haystack', () => {
    // extract_interpreter_body's regex looks for a leading '/", not $',
    // so it does not capture the ANSI-C body. The dangerous pattern is
    // still matched against the original command string, which contains
    // `rm -rf` literally with a real space.
    const r = runHook(bashEvent(`python -c $'import os\\nos.system("rm -rf /tmp")'`));
    expect(decision(r.stdout)).toBe('deny');
  });
});

describe('enforce-permissions: Bash empty input handling', () => {
  it('allows Bash with empty command (defensive — no command means nothing to run)', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: '' } });
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBeNull();
  });

  it('allows Bash with missing tool_input', () => {
    const r = runHook({ tool_name: 'Bash' });
    expect(r.exitCode).toBe(0);
    expect(decision(r.stdout)).toBeNull();
  });
});
