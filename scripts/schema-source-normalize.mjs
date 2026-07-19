#!/usr/bin/env node

/**
 * Normalizes TypeScript source text so that comment-only edits (and
 * whitespace-only edits) produce identical output, while any change to
 * actual code — including the contents of string/template literals and
 * regex literals — still produces different output.
 *
 * Used by scripts/generate-schema-version.mjs to compute SCHEMA_VERSION
 * from the *semantic* content of the wire-schema files rather than their
 * raw bytes, so a docstring fix doesn't force a client reload.
 *
 * Implementation: parses the source with the real TypeScript compiler
 * (`ts.createSourceFile`) — NOT a regex or hand-rolled scanner — so that
 * string/template/regex literals are correctly identified via full
 * grammatical context (e.g. distinguishing a regex literal's `/` from a
 * division operator, which a plain token scanner cannot do reliably; see
 * `ts.createScanner`'s known re-scan requirement for slash disambiguation).
 * A regex-based comment stripper would risk treating comment-like
 * character sequences inside string/regex literals as real comments,
 * silently dropping semantic content — the exact false-negative failure
 * mode this module exists to avoid.
 *
 * The AST is walked down to its leaf tokens (identifiers, keywords,
 * punctuation, literals). Each leaf's text is kept byte-for-byte verbatim.
 * The trivia (whitespace + comments) between two leaves is reduced to a
 * single normalizing separator:
 *   - ''   when there is no trivia at all (tokens were already adjacent)
 *   - ' '  when the non-comment whitespace in the gap contains no newline
 *   - '\n' when the non-comment whitespace in the gap contains a newline
 * Comment text itself never contributes to the separator decision, so
 * adding/removing/editing a comment cannot change the output. Indentation
 * and blank-line changes collapse to the same separator, so pure
 * whitespace edits also produce identical output.
 */

import ts from 'typescript';

/**
 * Recursively collect the leaf nodes (nodes with no children) of a parsed
 * source file, in source order. Leaf nodes correspond to the real tokens
 * emitted by the scanner: keywords, identifiers, punctuation, and literals
 * (including whole string/template/regex literals as single leaves).
 *
 * JSDoc comment nodes (`/** ... *\/`) are excluded entirely and NOT
 * recursed into. Unlike ordinary comments, the TypeScript parser expands a
 * JSDoc comment into its own AST subtree (tags, identifiers, etc. — see
 * `ts.SyntaxKind.FirstJSDocNode`..`LastJSDocNode`), so naive recursion would
 * surface comment-derived text (e.g. a `@param` tag's parameter name) as if
 * it were real code. The surrounding real tokens' trivia normalization
 * (`normalizeTrivia`, via `ts.getLeadingCommentRanges`) already accounts for
 * the byte range a JSDoc comment occupies, so skipping the subtree here is
 * sufficient — nothing needs to be substituted in its place.
 * @param {ts.Node} node
 * @param {ts.SourceFile} sourceFile
 * @param {ts.Node[]} out
 */
function collectLeaves(node, sourceFile, out) {
  if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
    return;
  }
  const children = node.getChildren(sourceFile);
  if (children.length === 0) {
    out.push(node);
    return;
  }
  for (const child of children) {
    collectLeaves(child, sourceFile, out);
  }
}

/**
 * Reduce a raw trivia span (whitespace + comments, as found between the end
 * of one token and the start of the next) to a single normalizing
 * separator. Comment byte ranges are excluded from consideration entirely:
 * only the non-comment whitespace bytes decide whether the separator is
 * '', ' ', or '\n'.
 * @param {string} fullText the complete source text
 * @param {number} start start offset of the trivia span (inclusive)
 * @param {number} end end offset of the trivia span (exclusive)
 * @returns {'' | ' ' | '\n'}
 */
function normalizeTrivia(fullText, start, end) {
  if (start >= end) return '';
  const commentRanges = ts.getLeadingCommentRanges(fullText, start) ?? [];
  let hasNewline = false;
  let hasContent = false;
  let cursor = start;
  for (const range of commentRanges) {
    if (range.pos > cursor) {
      const gap = fullText.slice(cursor, range.pos);
      hasContent = hasContent || gap.length > 0;
      hasNewline = hasNewline || gap.includes('\n');
    }
    cursor = range.end;
  }
  if (cursor < end) {
    const gap = fullText.slice(cursor, end);
    hasContent = hasContent || gap.length > 0;
    hasNewline = hasNewline || gap.includes('\n');
  }
  if (hasNewline) return '\n';
  if (hasContent) return ' ';
  return '';
}

/**
 * Normalize TypeScript source text: drop comments, collapse whitespace
 * (including blank lines and indentation) to a minimal separator, and keep
 * every other token's text byte-for-byte verbatim.
 *
 * @param {string} source raw file content
 * @returns {string} normalized text
 * @throws {Error} if `source` fails to parse as TypeScript. Callers MUST
 *   catch this and fall back to hashing the raw, unmodified bytes for the
 *   file — normalization is a best-effort optimization, and a parse
 *   failure must never silently drop content that could be semantic.
 */
export function normalizeSchemaSource(source) {
  const sourceFile = ts.createSourceFile(
    'schema.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  // `parseDiagnostics` is not part of the public .d.ts surface but has been
  // a stable runtime property of ts.SourceFile for many TypeScript major
  // versions (relied upon by tools such as ts-morph). ts.createSourceFile
  // never throws on malformed input by design (the parser is
  // error-tolerant), so this is the only way to detect a syntax error and
  // honor the fail-closed contract above.
  const diagnostics = /** @type {{ parseDiagnostics?: unknown[] }} */ (sourceFile)
    .parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    throw new Error(`schema source failed to parse (${diagnostics.length} syntax error(s))`);
  }

  const leaves = [];
  collectLeaves(sourceFile, sourceFile, leaves);

  const parts = [];
  for (const leaf of leaves) {
    const text = leaf.getText(sourceFile);
    if (text.length === 0) continue; // EndOfFileToken has no text
    parts.push(normalizeTrivia(source, leaf.pos, leaf.getStart(sourceFile)));
    parts.push(text);
  }
  return parts.join('').trim();
}
