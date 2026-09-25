import type { Kysely } from 'kysely';
import type {
  Database,
  McpServerPermissionRow as McpServerPermissionDbRow,
  McpServerPathPermissionRow as McpServerPathPermissionDbRow,
} from '../database/schema.js';
import type {
  McpServerPermissionRepository,
  McpServerPermissionRow,
  UpsertMcpServerPermissionParams,
} from './mcp-server-permission-repository.js';
import type { McpPermissionScope } from '../lib/mcp-server-permissions.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sqlite-mcp-server-permission-repository');

function fromRepositoryRow(row: McpServerPermissionDbRow): McpServerPermissionRow {
  return {
    id: row.id,
    scope: { kind: 'repository', repositoryId: row.repository_id },
    serverName: row.server_name,
    configHash: row.config_hash,
    decision: row.decision,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function fromPathRow(row: McpServerPathPermissionDbRow): McpServerPermissionRow {
  return {
    id: row.id,
    scope: { kind: 'path', locationPath: row.location_path },
    serverName: row.server_name,
    configHash: row.config_hash,
    decision: row.decision,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

/**
 * Backed by TWO physical tables -- `mcp_server_permissions` (keyed by
 * `repository_id`, migration v44) and `mcp_server_path_permissions` (keyed
 * by `location_path`, migration v45) -- selected by
 * `scope.kind` on every method. This is the single place that branches on
 * scope kind; every caller of `McpServerPermissionRepository` stays
 * scope-agnostic.
 */
export class SqliteMcpServerPermissionRepository implements McpServerPermissionRepository {
  constructor(private db: Kysely<Database>) {}

  async listByScope(scope: McpPermissionScope): Promise<McpServerPermissionRow[]> {
    if (scope.kind === 'repository') {
      const rows = await this.db
        .selectFrom('mcp_server_permissions')
        .where('repository_id', '=', scope.repositoryId)
        .selectAll()
        .execute();
      return rows.map(fromRepositoryRow);
    }
    const rows = await this.db
      .selectFrom('mcp_server_path_permissions')
      .where('location_path', '=', scope.locationPath)
      .selectAll()
      .execute();
    return rows.map(fromPathRow);
  }

  async upsert(params: UpsertMcpServerPermissionParams): Promise<McpServerPermissionRow> {
    const id = crypto.randomUUID();
    // `decidedAt` is supplied explicitly here -- never left to the column's
    // DB DEFAULT -- so it can be carried into the `doUpdateSet` clause below
    // and move forward on a repeat decision against the same key. The DB
    // DEFAULT only ever fires on the INSERT branch of an ON CONFLICT upsert;
    // relying on it here would leave `decided_at` frozen at the first
    // decision forever.
    const decidedAt = new Date().toISOString();

    if (params.scope.kind === 'repository') {
      const row = await this.db
        .insertInto('mcp_server_permissions')
        .values({
          id,
          repository_id: params.scope.repositoryId,
          server_name: params.serverName,
          config_hash: params.configHash,
          decision: params.decision,
          decided_by: params.decidedBy,
          decided_at: decidedAt,
        })
        .onConflict((oc) =>
          oc.columns(['repository_id', 'server_name', 'config_hash']).doUpdateSet({
            // Note: id and created_at are intentionally NOT updated (they must
            // never change after the initial insert).
            decision: params.decision,
            decided_by: params.decidedBy,
            decided_at: decidedAt,
          })
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      logger.debug(
        { repositoryId: params.scope.repositoryId, serverName: params.serverName, decision: params.decision },
        'MCP server permission upserted'
      );

      return fromRepositoryRow(row);
    }

    const row = await this.db
      .insertInto('mcp_server_path_permissions')
      .values({
        id,
        location_path: params.scope.locationPath,
        server_name: params.serverName,
        config_hash: params.configHash,
        decision: params.decision,
        decided_by: params.decidedBy,
        decided_at: decidedAt,
      })
      .onConflict((oc) =>
        oc.columns(['location_path', 'server_name', 'config_hash']).doUpdateSet({
          // Note: id and created_at are intentionally NOT updated (they must
          // never change after the initial insert).
          decision: params.decision,
          decided_by: params.decidedBy,
          decided_at: decidedAt,
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    logger.debug(
      { locationPath: params.scope.locationPath, serverName: params.serverName, decision: params.decision },
      'MCP server path permission upserted'
    );

    return fromPathRow(row);
  }

  async get(scope: McpPermissionScope, serverName: string, configHash: string): Promise<McpServerPermissionRow | null> {
    if (scope.kind === 'repository') {
      const row = await this.db
        .selectFrom('mcp_server_permissions')
        .where('repository_id', '=', scope.repositoryId)
        .where('server_name', '=', serverName)
        .where('config_hash', '=', configHash)
        .selectAll()
        .executeTakeFirst();
      return row ? fromRepositoryRow(row) : null;
    }
    const row = await this.db
      .selectFrom('mcp_server_path_permissions')
      .where('location_path', '=', scope.locationPath)
      .where('server_name', '=', serverName)
      .where('config_hash', '=', configHash)
      .selectAll()
      .executeTakeFirst();
    return row ? fromPathRow(row) : null;
  }
}
