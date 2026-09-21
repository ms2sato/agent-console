/**
 * Project `.mcp.json` discovery for the `claude-sdk` engine (epic #1636
 * Phase 5 PR-2, docs/design/embedded-agent-sdk-engine.md §4.5 "Discovery:
 * who reads what, as whom"). This file is production-side; the design's
 * Task 0 premise probe (`scripts/smoke/probe-sdk-declared-mcp-and-task.ts`)
 * measured the SDK-side behavior this discovery feeds, but does none of the
 * file-reading itself.
 */

import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServerConfig, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { isErrnoException } from './type-guards.js';

/**
 * The subset of the SDK's own {@link McpServerConfig} union a `.mcp.json`
 * entry can normalize into -- never the in-process
 * `McpSdkServerConfigWithInstance` arm (that arm is only ever constructed for
 * the reserved `console` server, sdk-engine.ts's `reservedMcpServers`; a
 * project entry from a JSON file can never carry a live server instance).
 * `Exclude`, not `Extract`, because `McpStdioServerConfig.type` is OPTIONAL
 * (`type?: 'stdio'`) in the SDK's own typing -- `Extract<McpServerConfig, {
 * type: 'stdio' | ... }>` would structurally drop that arm entirely (an
 * optional property does not satisfy a required one in a conditional-type
 * assignability check), which is not what this narrowing wants.
 */
type DiscoveredMcpServerConfig = Exclude<McpServerConfig, McpSdkServerConfigWithInstance>;

/**
 * The two `mcpServers` names `sdk-engine.ts`'s `buildOptions()` always
 * declares. An `.mcp.json` entry using either name is rejected at discovery
 * (never shadowed) -- see §4.5 D-E's "Door".
 */
const RESERVED_MCP_SERVER_NAMES = new Set(['agent-console', 'console']);

export interface DiscoveredMcpServer {
  name: string;
  /**
   * Empty string ONLY when the entry could not be normalized at all
   * (`decision: 'invalid'` with no computable config) -- see
   * {@link discoverProjectMcpServers}'s doc comment for why an invalid entry
   * still gets a hash field rather than an absent one.
   */
  hash: string;
  config: DiscoveredMcpServerConfig;
  decision: 'allowed' | 'pending' | 'rejected-reserved' | 'invalid';
}

export interface DiscoverProjectMcpServersResult {
  servers: DiscoveredMcpServer[];
  mcpJsonError?: string;
}

interface RawMcpJsonEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  type?: unknown;
  url?: unknown;
  headers?: unknown;
}

interface RawMcpJsonFile {
  mcpServers?: unknown;
}

/**
 * Fallback config for an entry that could not be normalized at all (neither
 * `command` nor `url`, or a type-mismatched value). Reported as `'invalid'`
 * with `hash: ''` -- chosen over throwing/dropping the entry because §4.5's
 * D-E "Door" text says discovery REPORTS every entry (including invalid
 * ones) to the server for the approval-decision UI (PR-3) to show, and
 * `config`/`hash` are not meaningful for an entry with no interpretable
 * shape.
 */
const INVALID_ENTRY_FALLBACK_CONFIG: DiscoveredMcpServerConfig = { type: 'stdio', command: '' };

function sortRecordKeys(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return sorted;
}

/** `raw` is a plain string array, or `undefined`/absent -- anything else is malformed. */
function normalizeStringArray(raw: unknown): { ok: true; value: string[] | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) return { ok: false };
  return { ok: true, value: raw as string[] };
}

/** `raw` is a plain string-to-string record, or `undefined`/absent -- anything else is malformed. */
function normalizeStringRecord(raw: unknown): { ok: true; value: Record<string, string> | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.every(([, value]) => typeof value === 'string')) return { ok: false };
  return { ok: true, value: sortRecordKeys(Object.fromEntries(entries) as Record<string, string>) };
}

/**
 * `JSON.stringify`'s field order follows object construction order, not a
 * canonical order, so the SAME config with fields assembled in a different
 * order would hash differently unless we fix the order explicitly here.
 * `env`/`headers` are already key-sorted by {@link normalizeStringRecord}.
 */
function canonicalize(config: DiscoveredMcpServerConfig): unknown {
  // Narrowed via `'command' in config`, not `config.type === 'stdio'`: the
  // SDK's own `McpStdioServerConfig.type` is OPTIONAL (`type?: 'stdio'`), so
  // a `type === 'stdio'` check cannot exclude that member from the `else`
  // branch below (its `type` could legitimately be `undefined` there too).
  // `command` is required on the stdio arm and absent on the http/sse arms,
  // so it is a real structural discriminant regardless of `type`'s presence.
  if ('command' in config) {
    return {
      type: config.type,
      command: config.command,
      args: config.args ?? null,
      env: config.env ?? null,
    };
  }
  return {
    type: config.type,
    url: config.url,
    headers: config.headers ?? null,
  };
}

function hashConfig(config: DiscoveredMcpServerConfig): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(config))).digest('hex');
}

/**
 * Normalizes one raw `.mcp.json` entry into {@link DiscoveredMcpServerConfig},
 * hashed BEFORE any `${VAR}` expansion (§4.5 D-B: "the hash's meaning is
 * catching `.mcp.json` changes", and the hash must bind to what the branch
 * DECLARES, not to what the environment happened to substitute --
 * {@link applyArgSubstitution} runs later, only on an already-allowed
 * entry's `args`, never before this hash is computed).
 */
function normalizeAndHash(raw: unknown): { config: DiscoveredMcpServerConfig; hash: string; valid: boolean } {
  if (typeof raw !== 'object' || raw === null) {
    return { config: INVALID_ENTRY_FALLBACK_CONFIG, hash: '', valid: false };
  }
  const entry = raw as RawMcpJsonEntry;
  const hasCommand = typeof entry.command === 'string';
  const hasUrl = typeof entry.url === 'string';

  if (hasCommand) {
    // Normalize before hashing: default `type: 'stdio'` when `command` is
    // present and `type` is absent, so a raw entry that omits `type` and an
    // explicit `type: 'stdio'` entry hash identically.
    if (entry.type !== undefined && entry.type !== 'stdio') {
      return { config: INVALID_ENTRY_FALLBACK_CONFIG, hash: '', valid: false };
    }
    const args = normalizeStringArray(entry.args);
    const env = normalizeStringRecord(entry.env);
    if (!args.ok || !env.ok) {
      return { config: INVALID_ENTRY_FALLBACK_CONFIG, hash: '', valid: false };
    }
    const config: DiscoveredMcpServerConfig = {
      type: 'stdio',
      command: entry.command as string,
      ...(args.value !== undefined ? { args: args.value } : {}),
      ...(env.value !== undefined ? { env: env.value } : {}),
    };
    return { config, hash: hashConfig(config), valid: true };
  }

  if (hasUrl) {
    // No documented default for a URL-based entry's `type` in the TUI's own
    // `.mcp.json` format -- 'http' is chosen as the more common dialect;
    // documented here as a deliberate choice, not an oversight.
    const type = entry.type === undefined ? 'http' : entry.type === 'http' || entry.type === 'sse' ? entry.type : null;
    if (type === null) {
      return { config: INVALID_ENTRY_FALLBACK_CONFIG, hash: '', valid: false };
    }
    const headers = normalizeStringRecord(entry.headers);
    if (!headers.ok) {
      return { config: INVALID_ENTRY_FALLBACK_CONFIG, hash: '', valid: false };
    }
    const config: DiscoveredMcpServerConfig = {
      type,
      url: entry.url as string,
      ...(headers.value !== undefined ? { headers: headers.value } : {}),
    };
    return { config, hash: hashConfig(config), valid: true };
  }

  return { config: INVALID_ENTRY_FALLBACK_CONFIG, hash: '', valid: false };
}

/**
 * Reads `<cwd>/.mcp.json` ONLY -- no walk-up to a git root. Deliberately
 * different from {@link ../agents-discovery.js}'s `discoverProjectAgents`,
 * which DOES walk from `cwd` up to the git root: the TUI's own `.mcp.json`
 * discovery is per-worktree/per-directory (Project scope, keyed by the
 * worktree in `~/.claude.json`'s own `projects[<cwd>]` record), while
 * `.claude/agents/*.md` discovery walks the whole chain. Do not "fix" this
 * into consistency with the agents loader -- the asymmetry mirrors the
 * TUI's own two different discovery rules (§4.5's "Discovery" section).
 *
 * Never throws: a missing file returns `{ servers: [] }`; an unreadable or
 * invalid file returns `{ servers: [], mcpJsonError: '<message>' }`. Every
 * OTHER entry-level problem (one bad entry among several) is reported
 * per-entry as `decision: 'invalid'` rather than failing the whole read, so
 * one malformed sibling never hides the rest.
 */
export async function discoverProjectMcpServers(
  cwd: string,
  allowedProjectMcpServers: Array<{ name: string; hash: string }>,
): Promise<DiscoverProjectMcpServersResult> {
  const filePath = path.join(cwd, '.mcp.json');

  let raw: string;
  try {
    raw = await Bun.file(filePath).text();
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return { servers: [] };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { servers: [], mcpJsonError: `Failed to read ${filePath}: ${message}` };
  }

  let parsed: RawMcpJsonFile;
  try {
    parsed = JSON.parse(raw) as RawMcpJsonFile;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { servers: [], mcpJsonError: `Failed to parse ${filePath}: ${message}` };
  }

  const rawServers = parsed.mcpServers;
  if (rawServers === undefined) {
    return { servers: [] };
  }
  if (typeof rawServers !== 'object' || rawServers === null || Array.isArray(rawServers)) {
    return { servers: [], mcpJsonError: `Malformed ${filePath}: "mcpServers" is not an object` };
  }

  const allowedIndex = new Map(allowedProjectMcpServers.map((s) => [s.name, s.hash]));
  const servers: DiscoveredMcpServer[] = [];
  for (const [name, rawEntry] of Object.entries(rawServers as Record<string, unknown>)) {
    const { config, hash, valid } = normalizeAndHash(rawEntry);
    const decision: DiscoveredMcpServer['decision'] = RESERVED_MCP_SERVER_NAMES.has(name)
      ? 'rejected-reserved'
      : !valid
        ? 'invalid'
        : allowedIndex.get(name) === hash
          ? 'allowed'
          : 'pending';
    servers.push({ name, hash, config, decision });
  }

  return { servers };
}

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Substitutes `${VAR}` / `${VAR:-default}` placeholders in an ALLOWED
 * server's `args`, from `env` (production callers pass the subprocess's own
 * environment -- the login shell's under elevation, the cleaned server
 * environment otherwise; see §4.5 D-F). Runs AFTER hashing, never before --
 * {@link discoverProjectMcpServers} hashes the raw, unexpanded entry so the
 * approval record binds to what the branch declares.
 *
 * §4.5 D-F, measured (arm G / probe-sdk-mcp-settings-sources.ts): the CLI
 * itself expands `${VAR}` for `env`/`headers`/`url` but NOT for `args`. This
 * function is the loader-side substitution that fills that gap for `args`
 * specifically -- never called for `env`/`headers`/`url`, which the CLI
 * already expands natively.
 *
 * An unset `VAR` with no default leaves the placeholder literal (never
 * throws) and reports one warning per unresolved placeholder, naming the
 * server so multiple servers' warnings stay distinguishable.
 */
export function applyArgSubstitution(
  serverName: string,
  args: string[] | undefined,
  env: NodeJS.ProcessEnv,
): { args: string[] | undefined; warnings: string[] } {
  if (args === undefined) return { args: undefined, warnings: [] };

  const warnings: string[] = [];
  const substituted = args.map((arg) =>
    arg.replace(VAR_PATTERN, (match: string, varName: string, defaultValue: string | undefined) => {
      const value = env[varName];
      if (value !== undefined) return value;
      if (defaultValue !== undefined) return defaultValue;
      warnings.push(
        `MCP server "${serverName}": environment variable "${varName}" is unset and has no default; leaving "${match}" literal in args`,
      );
      return match;
    }),
  );
  return { args: substituted, warnings };
}

/**
 * Reads the CLI's OWN config file (`${CLAUDE_CONFIG_DIR}/.claude.json` when
 * set, else `${HOME}/.claude.json`) for the set of User-scope and
 * Local-scope (this `cwd`) MCP server NAMES -- never their configs, and
 * never anything else in the file. This is read-only and exists for exactly
 * one purpose: the containment detector's expected-name set (§4.5 D-E's
 * "Wall") needs to know which names the CLI itself will load under
 * `settingSources: ['user', 'local']` so a legitimately-loaded server is not
 * mistaken for a leak.
 *
 * `cwd` is matched against `projects` by EXACT STRING, never realpath'd --
 * a documented simplification (§4.5's Task 0 record lists "whether the
 * CLI's key is the realpath" as a to-RECORD item, not a to-fix one).
 *
 * A missing `mcpServers` or `projects` key is treated as "no names from
 * that scope" rather than a failure -- a `~/.claude.json` with no
 * configured servers at all is a legitimate, common state. Only a
 * structural problem (the file itself unreadable/unparseable, or a
 * present-but-wrong-shaped `mcpServers`/`projects`/`projects[cwd]` value)
 * sets `unavailable: true`. Never throws.
 */
export async function readUserLocalMcpNames(
  cwd: string,
): Promise<{ names: Set<string>; unavailable: boolean }> {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const filePath = configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');

  let raw: string;
  try {
    raw = await Bun.file(filePath).text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to read ${filePath} for user/local MCP server names: ${message}`);
    return { names: new Set(), unavailable: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to parse ${filePath} for user/local MCP server names: ${message}`);
    return { names: new Set(), unavailable: true };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn(`Malformed ${filePath}: root is not an object`);
    return { names: new Set(), unavailable: true };
  }
  const root = parsed as Record<string, unknown>;
  const names = new Set<string>();

  if (root.mcpServers !== undefined) {
    if (typeof root.mcpServers !== 'object' || root.mcpServers === null || Array.isArray(root.mcpServers)) {
      console.warn(`Malformed ${filePath}: top-level "mcpServers" is not an object`);
      return { names: new Set(), unavailable: true };
    }
    for (const name of Object.keys(root.mcpServers as Record<string, unknown>)) names.add(name);
  }

  if (root.projects !== undefined) {
    if (typeof root.projects !== 'object' || root.projects === null || Array.isArray(root.projects)) {
      console.warn(`Malformed ${filePath}: "projects" is not an object`);
      return { names: new Set(), unavailable: true };
    }
    const projectEntry = (root.projects as Record<string, unknown>)[cwd];
    if (projectEntry !== undefined) {
      if (typeof projectEntry !== 'object' || projectEntry === null || Array.isArray(projectEntry)) {
        console.warn(`Malformed ${filePath}: projects["${cwd}"] is not an object`);
        return { names: new Set(), unavailable: true };
      }
      const localMcpServers = (projectEntry as Record<string, unknown>).mcpServers;
      if (localMcpServers !== undefined) {
        if (typeof localMcpServers !== 'object' || localMcpServers === null || Array.isArray(localMcpServers)) {
          console.warn(`Malformed ${filePath}: projects["${cwd}"].mcpServers is not an object`);
          return { names: new Set(), unavailable: true };
        }
        for (const name of Object.keys(localMcpServers as Record<string, unknown>)) names.add(name);
      }
    }
  }

  return { names, unavailable: false };
}
