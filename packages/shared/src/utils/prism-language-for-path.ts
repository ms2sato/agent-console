/**
 * Single writer of the file-path -> Prism language mapping, shared by the
 * server (which stamps `language` on a file-viewer content response) and the
 * client (which highlights with it). The table is the behaviour of the diff
 * viewer's former private `getLanguageFromPath`, unchanged.
 *
 * The result is a Prism language NAME or {@link UNKNOWN_PRISM_LANGUAGE}. The unknown
 * fallback is `'text'` on the wire; a client that feeds the name to Prism maps
 * it to Prism's own plain grammar (`'plain'`). The client must have a grammar
 * registered for every name in {@link PRISM_LANGUAGE_NAMES}.
 */

const LANGUAGE_BY_EXTENSION = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sql: 'sql',
  rb: 'ruby',
  ruby: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  erb: 'markup',
  rhtml: 'markup',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
} as const;

/** Lower-cased base names that carry no (useful) extension. */
const LANGUAGE_BY_FILE_NAME = {
  dockerfile: 'bash',
  gemfile: 'ruby',
  rakefile: 'ruby',
  '.gitignore': 'bash',
  '.env': 'bash',
} as const;

/** What {@link prismLanguageForPath} returns for a path it has no rule for. */
export const UNKNOWN_PRISM_LANGUAGE = 'text';

export type PrismLanguageName =
  | (typeof LANGUAGE_BY_EXTENSION)[keyof typeof LANGUAGE_BY_EXTENSION]
  | (typeof LANGUAGE_BY_FILE_NAME)[keyof typeof LANGUAGE_BY_FILE_NAME]
  | typeof UNKNOWN_PRISM_LANGUAGE;

/**
 * Every language name {@link prismLanguageForPath} can return, sorted. Derived
 * from the two tables above, so it cannot drift from them.
 */
export const PRISM_LANGUAGE_NAMES: readonly PrismLanguageName[] = [
  ...new Set<PrismLanguageName>([
    ...Object.values(LANGUAGE_BY_EXTENSION),
    ...Object.values(LANGUAGE_BY_FILE_NAME),
    UNKNOWN_PRISM_LANGUAGE,
  ]),
].sort();

// Own-key lookups only: a plain-object index would resolve `constructor` or
// `toString` (e.g. a file named `a.constructor`) to an inherited function.
const extensionMap = new Map<string, PrismLanguageName>(Object.entries(LANGUAGE_BY_EXTENSION));
const fileNameMap = new Map<string, PrismLanguageName>(Object.entries(LANGUAGE_BY_FILE_NAME));

/**
 * Prism language for a file path, from its extension or special file name.
 * An exact match on the lower-cased base name wins over the extension.
 */
export function prismLanguageForPath(filePath: string): PrismLanguageName {
  const fileName = filePath.split('/').pop()?.toLowerCase() || '';
  const byName = fileNameMap.get(fileName);
  if (byName) return byName;
  const extension = filePath.split('.').pop()?.toLowerCase() || '';
  return extensionMap.get(extension) ?? UNKNOWN_PRISM_LANGUAGE;
}
