/**
 * DelegationTemplateService — file-based named-template registry per session.
 *
 * Each session owns a single JSON file mapping template name -> template body.
 * Templates are appended to delegate_to_worktree prompts via the `useTemplates`
 * parameter, replacing hand-written delegation boilerplate.
 *
 * Storage path: {baseDir}/delegation-templates/{sessionId}.json
 * File schema:  Record<templateName, templateContent>
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SessionDataPathResolver } from '../lib/session-data-path-resolver.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('delegation-template-service');

/** Maximum size of a single template body. Matches MemoService. */
const MAX_TEMPLATE_CONTENT_BYTES = 256 * 1024;

/** Allowed template names: alphanumeric, hyphen, underscore. 1–64 chars. */
const TEMPLATE_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export interface DelegationTemplate {
  name: string;
  content: string;
}

export interface DelegationTemplateLookupResult {
  /** Templates that were found, in the order requested. */
  found: DelegationTemplate[];
  /** Names that were not present in the registry (preserves request order). */
  missing: string[];
}

export class DelegationTemplateService {
  private validateSessionId(sessionId: string): void {
    const safe = path.basename(sessionId);
    if (safe !== sessionId || sessionId.includes('..') || sessionId.includes('/')) {
      throw new Error(`Invalid sessionId: ${sessionId}`);
    }
  }

  private validateName(name: string): void {
    if (!TEMPLATE_NAME_REGEX.test(name)) {
      throw new Error(
        `Invalid template name: ${JSON.stringify(name)} (must be 1–64 chars, alphanumeric/hyphen/underscore)`,
      );
    }
  }

  private validateContent(content: string): void {
    const size = Buffer.byteLength(content, 'utf-8');
    if (size > MAX_TEMPLATE_CONTENT_BYTES) {
      throw new Error(`Template content exceeds maximum size of ${MAX_TEMPLATE_CONTENT_BYTES} bytes (got ${size})`);
    }
  }

  /**
   * Read the per-session registry from disk. Returns an empty map if no file
   * exists. Throws if the file exists but is unreadable or has invalid shape.
   */
  private async readRegistry(
    sessionId: string,
    resolver: SessionDataPathResolver,
  ): Promise<Record<string, string>> {
    const filePath = resolver.getDelegationTemplatesPath(sessionId);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse delegation templates file ${filePath}: ${(err as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Delegation templates file ${filePath} has invalid shape (expected object)`);
    }
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`Delegation templates file ${filePath} has non-string value for key ${JSON.stringify(k)}`);
      }
      map[k] = v;
    }
    return map;
  }

  /**
   * Write the per-session registry to disk atomically (write tmp + rename).
   */
  private async writeRegistry(
    sessionId: string,
    resolver: SessionDataPathResolver,
    registry: Record<string, string>,
  ): Promise<string> {
    const dir = resolver.getDelegationTemplatesDir();
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, `${sessionId}.json`);
    const tmpPath = path.join(dir, `.tmp-${sessionId}.json`);
    const body = JSON.stringify(registry, null, 2);

    await fs.writeFile(tmpPath, body, 'utf-8');
    try {
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
    return filePath;
  }

  /**
   * Register (or overwrite) a template. Returns the absolute file path of the
   * registry file after the write.
   */
  async registerTemplate(
    sessionId: string,
    name: string,
    content: string,
    resolver: SessionDataPathResolver,
  ): Promise<string> {
    this.validateSessionId(sessionId);
    this.validateName(name);
    this.validateContent(content);

    const registry = await this.readRegistry(sessionId, resolver);
    registry[name] = content;
    const filePath = await this.writeRegistry(sessionId, resolver, registry);
    logger.debug({ sessionId, name, filePath }, 'Delegation template registered');
    return filePath;
  }

  /**
   * List all templates registered for a session, sorted by name.
   * Returns an empty array if no registry file exists.
   */
  async listTemplates(
    sessionId: string,
    resolver: SessionDataPathResolver,
  ): Promise<DelegationTemplate[]> {
    this.validateSessionId(sessionId);
    const registry = await this.readRegistry(sessionId, resolver);
    return Object.keys(registry)
      .sort()
      .map((name) => ({ name, content: registry[name] }));
  }

  /**
   * Delete a template by name. Idempotent: if the name does not exist, returns
   * `{ deleted: false }` without throwing.
   */
  async deleteTemplate(
    sessionId: string,
    name: string,
    resolver: SessionDataPathResolver,
  ): Promise<{ deleted: boolean }> {
    this.validateSessionId(sessionId);
    this.validateName(name);

    const registry = await this.readRegistry(sessionId, resolver);
    if (!(name in registry)) {
      return { deleted: false };
    }
    delete registry[name];
    await this.writeRegistry(sessionId, resolver, registry);
    logger.debug({ sessionId, name }, 'Delegation template deleted');
    return { deleted: true };
  }

  /**
   * Resolve a list of template names for use by `delegate_to_worktree`.
   * Preserves the input order in the `found` array.
   *
   * Empty `names` returns `{ found: [], missing: [] }` (boundary: no-op).
   */
  async lookupTemplates(
    sessionId: string,
    names: string[],
    resolver: SessionDataPathResolver,
  ): Promise<DelegationTemplateLookupResult> {
    this.validateSessionId(sessionId);
    if (names.length === 0) {
      return { found: [], missing: [] };
    }

    const registry = await this.readRegistry(sessionId, resolver);
    const found: DelegationTemplate[] = [];
    const missing: string[] = [];
    for (const name of names) {
      if (name in registry) {
        found.push({ name, content: registry[name] });
      } else {
        missing.push(name);
      }
    }
    return { found, missing };
  }

  /**
   * Delete the per-session registry file entirely. Used on session deletion.
   * Does not throw if the file does not exist.
   */
  async deleteAllForSession(
    sessionId: string,
    resolver: SessionDataPathResolver,
  ): Promise<void> {
    this.validateSessionId(sessionId);
    const filePath = resolver.getDelegationTemplatesPath(sessionId);
    await fs.rm(filePath, { force: true });
    logger.debug({ sessionId }, 'Delegation templates cleared for session');
  }
}
