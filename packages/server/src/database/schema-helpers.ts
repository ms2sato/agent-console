import { sql, CreateTableBuilder, ColumnDefinitionBuilder } from 'kysely';

/**
 * ISO 8601 datetime format pattern for SQLite CHECK constraint.
 * Matches: YYYY-MM-DDTHH:mm:ss.sssZ (with optional milliseconds)
 */
const ISO8601_GLOB_PATTERN = '????-??-??T??:??:??*Z';

/**
 * SQL expression for current UTC time in ISO 8601 format.
 * Used as DEFAULT value for datetime columns.
 */
const NOW_ISO8601 = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/**
 * Options for addDatetime helper.
 */
interface DatetimeOptions {
  /** If true, sets DEFAULT to current UTC time in ISO 8601 format */
  defaultNow?: boolean;
}

/**
 * Add a datetime column with ISO 8601 CHECK constraint.
 * Always stores as TEXT in ISO 8601 UTC format (YYYY-MM-DDTHH:mm:ss.sssZ).
 *
 * This ensures:
 * 1. Consistent datetime format across the database
 * 2. Lexicographic sorting works correctly for chronological order
 * 3. Invalid datetime formats are rejected at the database level
 *
 * @param builder - The CreateTableBuilder to add the column to
 * @param tableName - Table name (used for constraint naming)
 * @param columnName - Column name
 * @param build - Optional column builder function (e.g., col => col.notNull())
 * @param options - Optional settings (e.g., { defaultNow: true })
 * @returns The builder with the column and constraint added
 *
 * @example
 * ```typescript
 * let table = db.schema.createTable('sessions')
 *   .addColumn('id', 'text', col => col.primaryKey());
 * // With notNull and default current time
 * table = addDatetime(table, 'sessions', 'created_at', col => col.notNull(), { defaultNow: true });
 * // Nullable with default current time
 * table = addDatetime(table, 'sessions', 'updated_at', undefined, { defaultNow: true });
 * await table.execute();
 * ```
 */
export function addDatetime<T extends string, C extends string>(
  builder: CreateTableBuilder<T, C>,
  tableName: string,
  columnName: string,
  build?: (col: ColumnDefinitionBuilder) => ColumnDefinitionBuilder,
  options?: DatetimeOptions
) {
  const columnBuilder = (col: ColumnDefinitionBuilder) => {
    // Apply defaultNow if specified
    if (options?.defaultNow) {
      col = col.defaultTo(NOW_ISO8601);
    }
    // Apply custom build function if provided
    if (build) {
      col = build(col);
    }
    return col;
  };

  return builder.addColumn(columnName, 'text', columnBuilder).addCheckConstraint(
    `${tableName}_${columnName}_iso8601`,
    // Allow NULL values to pass CHECK constraint (NULL GLOB pattern = NULL, not false)
    sql`${sql.ref(columnName)} IS NULL OR ${sql.ref(columnName)} GLOB '${sql.raw(ISO8601_GLOB_PATTERN)}'`
  );
}
