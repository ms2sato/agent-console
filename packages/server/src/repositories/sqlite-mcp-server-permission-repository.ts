import type { Kysely } from 'kysely';
import type { Database, McpServerPermissionRow as McpServerPermissionDbRow } from '../database/schema.js';
import type {
  McpServerPermissionRepository,
  McpServerPermissionRow,
  UpsertMcpServerPermissionParams,
} from './mcp-server-permission-repository.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('sqlite-mcp-server-permission-repository');

function toDomainRow(row: McpServerPermissionDbRow): McpServerPermissionRow {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    serverName: row.server_name,
    configHash: row.config_hash,
    decision: row.decision,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export class SqliteMcpServerPermissionRepository implements McpServerPermissionRepository {
  constructor(private db: Kysely<Database>) {}

  async listByRepository(repositoryId: string): Promise<McpServerPermissionRow[]> {
    const rows = await this.db
      .selectFrom('mcp_server_permissions')
      .where('repository_id', '=', repositoryId)
      .selectAll()
      .execute();
    return rows.map(toDomainRow);
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

    const row = await this.db
      .insertInto('mcp_server_permissions')
      .values({
        id,
        repository_id: params.repositoryId,
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
      { repositoryId: params.repositoryId, serverName: params.serverName, decision: params.decision },
      'MCP server permission upserted',
    );

    return toDomainRow(row);
  }

  async get(repositoryId: string, serverName: string, configHash: string): Promise<McpServerPermissionRow | null> {
    const row = await this.db
      .selectFrom('mcp_server_permissions')
      .where('repository_id', '=', repositoryId)
      .where('server_name', '=', serverName)
      .where('config_hash', '=', configHash)
      .selectAll()
      .executeTakeFirst();
    return row ? toDomainRow(row) : null;
  }
}
