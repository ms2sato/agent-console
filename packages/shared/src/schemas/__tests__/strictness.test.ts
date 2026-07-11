import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';

// Import every wire-schema module as a namespace so the walker inspects all
// exported schemas. Adding a new schemas/*.ts file requires adding it here.
import * as agent from '../agent.js';
import * as appServerMessage from '../app-server-message.js';
import * as auth from '../auth.js';
import * as embeddedAgent from '../embedded-agent.js';
import * as messageTemplate from '../message-template.js';
import * as message from '../message.js';
import * as notification from '../notification.js';
import * as repository from '../repository.js';
import * as session from '../session.js';
import * as system from '../system.js';
import * as worker from '../worker.js';

const MODULES: Record<string, Record<string, unknown>> = {
  agent,
  'app-server-message': appServerMessage,
  auth,
  'embedded-agent': embeddedAgent,
  'message-template': messageTemplate,
  message,
  notification,
  repository,
  session,
  system,
  worker,
};

/** A valibot schema node is any object carrying `kind === 'schema'`. */
function isSchemaNode(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'schema';
}

/**
 * Recursively walk a valibot schema AST, collecting the paths of every plain
 * `object` schema (the forbidden non-strict variant). Recurses through every
 * container shape valibot uses to nest schemas.
 */
function collectPlainObjectPaths(node: unknown, path: string, visited: WeakSet<object>, out: string[]): void {
  if (!isSchemaNode(node)) return;
  if (visited.has(node)) return;
  visited.add(node);

  if (node.type === 'object') {
    out.push(path);
  }

  const entries = node.entries;
  if (entries && typeof entries === 'object') {
    for (const [key, child] of Object.entries(entries)) {
      collectPlainObjectPaths(child, `${path}.entries.${key}`, visited, out);
    }
  }

  for (const listKey of ['options', 'pipe'] as const) {
    const list = node[listKey];
    if (Array.isArray(list)) {
      list.forEach((child, i) => collectPlainObjectPaths(child, `${path}.${listKey}[${i}]`, visited, out));
    }
  }

  for (const singleKey of ['wrapped', 'item', 'value', 'key'] as const) {
    if (singleKey in node) {
      collectPlainObjectPaths(node[singleKey], `${path}.${singleKey}`, visited, out);
    }
  }
}

describe('wire schema strictness invariant', () => {
  it('has no plain v.object anywhere in any exported schema (only v.strictObject)', () => {
    const violations: string[] = [];
    const visited = new WeakSet<object>();

    for (const [moduleName, mod] of Object.entries(MODULES)) {
      for (const [exportName, value] of Object.entries(mod)) {
        if (!isSchemaNode(value)) continue;
        collectPlainObjectPaths(value, `${moduleName}:${exportName}`, visited, violations);
      }
    }

    expect(violations).toEqual([]);
  });

  it('detects a plain v.object when one is introduced (walker sanity check)', () => {
    // A throwaway schema with a nested plain object; proves the walker would
    // catch a regression rather than passing vacuously.
    const bad = v.strictObject({ inner: v.object({ a: v.string() }) });
    const out: string[] = [];
    collectPlainObjectPaths(bad, 'sanity:bad', new WeakSet(), out);
    expect(out).toEqual(['sanity:bad.entries.inner']);
  });
});
