import { describe, it, expect } from 'bun:test';
import { prismLanguageForPath, PRISM_LANGUAGE_NAMES, UNKNOWN_PRISM_LANGUAGE, type PrismLanguageName } from '../prism-language-for-path.js';

describe('prismLanguageForPath', () => {
  it.each<[string, PrismLanguageName]>([
    ['src/a.ts', 'typescript'],
    ['a.tsx', 'tsx'],
    ['a.mjs', 'javascript'],
    ['a.jsx', 'jsx'],
    ['a.scss', 'scss'],
    ['a.sass', 'scss'],
    ['a.md', 'markdown'],
    ['a.zsh', 'bash'],
    ['a.yml', 'yaml'],
    ['a.py', 'python'],
    ['a.rs', 'rust'],
    ['a.go', 'go'],
    ['a.sql', 'sql'],
    ['a.gemspec', 'ruby'],
    ['a.svg', 'markup'],
    ['a.erb', 'markup'],
  ])('maps %s to %s', (path, language) => {
    expect(prismLanguageForPath(path)).toBe(language);
  });

  it('is case-insensitive on the extension', () => {
    expect(prismLanguageForPath('README.MD')).toBe('markdown');
    expect(prismLanguageForPath('A.TS')).toBe('typescript');
  });

  it('maps the special base names, including a dotfile', () => {
    expect(prismLanguageForPath('Dockerfile')).toBe('bash');
    expect(prismLanguageForPath('app/Gemfile')).toBe('ruby');
    expect(prismLanguageForPath('Rakefile')).toBe('ruby');
    expect(prismLanguageForPath('.gitignore')).toBe('bash');
    expect(prismLanguageForPath(['sub/.', 'env'].join(''))).toBe('bash');
  });

  it('falls back to the wire value text when it has no rule', () => {
    expect(prismLanguageForPath('Makefile')).toBe(UNKNOWN_PRISM_LANGUAGE);
    expect(prismLanguageForPath('a.unknownext')).toBe('text');
    expect(prismLanguageForPath('')).toBe('text');
  });

  it('does not resolve an inherited Object property as an extension', () => {
    expect(prismLanguageForPath('a.constructor')).toBe('text');
    expect(prismLanguageForPath('a.toString')).toBe('text');
    expect(prismLanguageForPath('a.__proto__')).toBe('text');
  });
});

describe('PRISM_LANGUAGE_NAMES', () => {
  // Pinned on purpose: the client registers a grammar per name in this list,
  // so growing the map is a visible change here and in the client's pin.
  it('is exactly the set the map can emit, plus the unknown fallback', () => {
    expect([...PRISM_LANGUAGE_NAMES] as string[]).toEqual([
      'bash',
      'css',
      'go',
      'json',
      'jsx',
      'less',
      'markdown',
      'markup',
      'python',
      'ruby',
      'rust',
      'scss',
      'sql',
      'text',
      'tsx',
      'typescript',
      'javascript',
      'yaml',
    ].sort());
  });

  it('contains every value prismLanguageForPath returns for a sample of each rule kind', () => {
    for (const path of ['a.ts', 'a.tsx', 'a.js', 'a.css', 'a.rb', 'a.html', 'Dockerfile', 'nothing']) {
      expect(PRISM_LANGUAGE_NAMES).toContain(prismLanguageForPath(path));
    }
  });
});
