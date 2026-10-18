import type { Language } from 'prism-react-renderer';
import { UNKNOWN_PRISM_LANGUAGE, prismLanguageForPath } from '@agent-console/shared';

// Registers every grammar the shared language map can emit (see
// `__tests__/prism-grammar.test.ts`), so importing this module is enough to
// highlight with `rendererLanguageForPath`.
import './prism-languages';

/** Prism's own name for "no grammar": renders plain tokens. */
const PRISM_PLAIN = 'plain';

/**
 * Maps a language name from the shared map (or from the file-viewer wire's
 * `language` field), where an unknown language is `'text'`, to the name
 * prism-react-renderer expects.
 */
export function toRendererLanguage(name: string): Language {
  return name === UNKNOWN_PRISM_LANGUAGE ? PRISM_PLAIN : name;
}

/** prism-react-renderer language for a file path. */
export function rendererLanguageForPath(filePath: string): Language {
  return toRendererLanguage(prismLanguageForPath(filePath));
}
