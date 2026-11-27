// The scalar fences scan reads used before the join-once form (`EXISTS (SELECT 1 FROM actor_ok)` and
// `(SELECT org_id FROM actor_ok)` at every use), rebuilt from a join-once fence so the differential
// tests can run the original statements. Test support only.
import { tenantFilter } from '../../platform/authority-read.ts';
import type { SqlValue } from '../../platform/db.ts';
import { type ScanReadAuthority, scanRead } from './repo-read-authority.ts';

export type LegacyAuth = ScanReadAuthority & {
  ok: string;
  tenant: (alias: string, table: string) => string;
};

export function legacyOf(auth: ScanReadAuthority): LegacyAuth {
  // A platform key's tenant is the only one that asserts `ao.org_id IS NULL`.
  const platform = auth.tenantOnce('x', 'scans').includes('ao.org_id IS NULL');
  const named = auth.rows.includes('named nm');
  return {
    ...auth,
    ok: 'EXISTS (SELECT 1 FROM actor_ok)',
    tenant: (alias, table) =>
      platform
        ? `(SELECT org_id FROM actor_ok) IS NULL AND ${named ? `${alias}.org_id = (SELECT org_id FROM named) AND ` : ''}${alias}.mode = (SELECT mode FROM actor_ok)`
        : tenantFilter(alias, table, 'org_mode'),
  };
}

/** `scanRead` for an original that has no `ao`: exempt from the join-once check, by design. */
export const legacyRead = (
  db: D1Database,
  auth: ScanReadAuthority,
  sql: string,
  params: readonly SqlValue[] = [],
  extra?: { ctes: string; params?: readonly SqlValue[] },
) => scanRead(db, auth, sql, params, extra, 'scalar-form original kept for the differential test');
