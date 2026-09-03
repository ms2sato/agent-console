// Ambient type declaration for the sibling schema-source-normalize.mjs.
//
// TypeScript's "bundler" module resolution requires a co-located `.d.mts`
// file (not `.d.ts`) to type an untyped ESM module referenced via a `.mjs`
// specifier; without it, `import { normalizeSchemaSource } from
// './schema-source-normalize.mjs'` fails with TS7016 ("implicitly has an
// 'any' type"). Declares only the export that TypeScript consumers actually
// import; extend this file if a consumer needs another named export.
export function normalizeSchemaSource(source: string): string;
