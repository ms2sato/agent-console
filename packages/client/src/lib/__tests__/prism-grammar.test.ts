import { describe, it, expect } from 'bun:test';
import { Prism } from 'prism-react-renderer';
import { PRISM_LANGUAGE_NAMES, UNKNOWN_PRISM_LANGUAGE } from '@agent-console/shared';
import { rendererLanguageForPath, toRendererLanguage } from '../prism-grammar';

describe('toRendererLanguage', () => {
  it("maps the wire's unknown name 'text' to Prism's 'plain'", () => {
    expect(toRendererLanguage('text')).toBe('plain');
  });

  it('passes a real language name through unchanged', () => {
    expect(toRendererLanguage('typescript')).toBe('typescript');
  });
});

describe('rendererLanguageForPath', () => {
  it('resolves an extension, a special file name and the unknown fallback', () => {
    expect(rendererLanguageForPath('src/a.ts')).toBe('typescript');
    expect(rendererLanguageForPath('docker/Dockerfile')).toBe('bash');
    expect(rendererLanguageForPath('notes.unknownext')).toBe('plain');
  });
});

describe('Prism grammar coverage of the shared language map', () => {
  const emittable = PRISM_LANGUAGE_NAMES.filter((name) => name !== UNKNOWN_PRISM_LANGUAGE);

  it('lists at least the languages the diff viewer has always supported', () => {
    expect(emittable.length).toBeGreaterThan(10);
  });

  it('has a registered Prism grammar for every name the shared map can emit', () => {
    // Importing `../prism-grammar` above registers the extra grammars.
    const missing = emittable.filter((name) => Prism.languages[name] === undefined);
    expect(missing).toEqual([]);
  });

  it('control: a name the shared map cannot emit has no registered grammar', () => {
    expect(Prism.languages['definitely-not-a-grammar']).toBeUndefined();
  });
});
