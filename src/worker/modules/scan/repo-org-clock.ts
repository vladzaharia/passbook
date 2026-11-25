import { TimeZoneSchema } from '../../../shared/contracts/scan-base.ts';
import { resolveOrgTimeZone } from '../../../shared/time-zone.ts';
import { first, stmt } from '../../platform/db.ts';

const SQL = "SELECT value FROM settings WHERE scope = ? AND key = 'org.timeZone'";

/** The org's `org.timeZone` (unset: the default zone), to batch with other reads. */
export const orgTimeZoneStmt = (db: D1Database, orgId: string): D1PreparedStatement =>
  stmt(db, SQL, [`org:${orgId}`]);

/** The zone a `orgTimeZoneStmt` result holds; the default when unset or no longer valid. */
export function orgTimeZoneOf(result: D1Result | undefined): string {
  const row = result?.results?.[0] as { value: string } | undefined;
  if (!row) return resolveOrgTimeZone(null);
  const zone = TimeZoneSchema.safeParse(JSON.parse(row.value));
  return resolveOrgTimeZone(zone.success ? zone.data : null);
}

export async function readOrgTimeZone(db: D1Database, orgId: string): Promise<string> {
  const row = await first<{ value: string }>(db, SQL, [`org:${orgId}`]);
  return orgTimeZoneOf(row ? ({ results: [row] } as unknown as D1Result) : undefined);
}
