/** Read-only evidence from the three persisted tables. No allocator uses this utility. */
export interface CommandInventoryRow {
  command_id: string;
  call_session_id: string | null;
  call_device_id: string | null;
  call_id: string | null;
  sms_task_id: string | null;
  sms_device_id: string | null;
  registry_command_type: string | null;
  registry_owner_type: string | null;
  registry_owner_id: string | null;
  registry_device_id: string | null;
}

export interface CommandInventoryPage {
  rows: CommandInventoryRow[];
  nextCursor: string | null;
  limitations: readonly string[];
}

/** Query-compatible adapter, e.g. a pg Pool or PoolClient supplied by the caller. */
export interface InventoryDatabase {
  query(sql: string, values: (string | number | null)[]): Promise<{ rows: CommandInventoryRow[] }>;
}

export const INVENTORY_LIMITATIONS = [
  'Only currently persisted rows in call_outbound_attempt, sms_dispatch_attempt, and command_namespace_reservation are included.',
  'Android in-memory command histories are unavailable, including entries lost on restart or evicted; transport and other allocator histories are not inventoried.',
  'Migration 0020 was created empty and existing allocators do not necessarily consult it; absence from the registry does not prove an ID was unused.',
  'Pages are separate database snapshots unless the caller supplies a stable transaction snapshot; concurrent changes can be missed or repeated, so pagination does not establish global absence or completeness.',
  'Matching IDs are evidence of overlap, not proof of ownership, collision consequences, or safe activation.',
] as const;

// A single statement gives each page one database snapshot. Explicit C collation
// makes joins, ordering and cursor comparisons use the same exact ID semantics.
const INVENTORY_SQL = `WITH ids AS (
  SELECT command_id COLLATE "C" AS command_id FROM call_outbound_attempt
  UNION
  SELECT command_id COLLATE "C" FROM sms_dispatch_attempt
  UNION
  SELECT command_id COLLATE "C" FROM command_namespace_reservation
)
SELECT ids.command_id, c.session_id AS call_session_id, c.device_id AS call_device_id,
       c.call_id, s.task_id AS sms_task_id, s.device_id AS sms_device_id,
       r.command_type AS registry_command_type, r.owner_type AS registry_owner_type,
       r.owner_id AS registry_owner_id, r.device_id AS registry_device_id
FROM ids
LEFT JOIN call_outbound_attempt c ON c.command_id COLLATE "C" = ids.command_id
LEFT JOIN sms_dispatch_attempt s ON s.command_id COLLATE "C" = ids.command_id
LEFT JOIN command_namespace_reservation r ON r.command_id = ids.command_id
WHERE ($1::text IS NULL OR ids.command_id > $1::text COLLATE "C")
ORDER BY ids.command_id COLLATE "C"
LIMIT $2`;

/**
 * Inventories every observed ID, including attempts absent from the registry and
 * registry-only IDs. A row with both attempt IDs is a cross-table duplicate;
 * a row with an attempt and null registry_owner_id is an unregistered legacy
 * candidate, not a conclusion about when it was created. Examine registry fields
 * directly rather than assuming an owner naming convention.
 *
 * Example (with a caller-owned pg Pool or PoolClient):
 *   const page = await inventoryCommandIds(pool, { limit: 100 });
 *   // Process page.rows and page.limitations. Pass page.nextCursor as after
 *   // only when it is not null (an empty string is a valid cursor).
 * For a consistent multi-page view, the caller must use one client with an
 * appropriate stable transaction snapshot. This utility opens no transaction.
 */
export async function inventoryCommandIds(
  db: InventoryDatabase,
  options: { limit?: number; after?: string | null } = {},
): Promise<CommandInventoryPage> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be an integer between 1 and 1000');
  const after = options.after ?? null;
  if (after !== null && typeof after !== 'string') throw new Error('after must be a string or null');
  if (after !== null && (after.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(after))) {
    throw new Error('after must be valid PostgreSQL text');
  }
  const result = await db.query(INVENTORY_SQL, [after, limit + 1]);
  const rows = result.rows.slice(0, limit);
  return { rows, nextCursor: result.rows.length > limit ? rows[rows.length - 1]!.command_id : null, limitations: INVENTORY_LIMITATIONS };
}
