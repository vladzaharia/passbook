import { withoutTrigger } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';

export async function staffTenantState(env: Pick<AppEnv, 'DB'>) {
  return {
    staff: await all(env.DB, 'SELECT * FROM scan_staff ORDER BY id'),
    bindings: await all(
      env.DB,
      'SELECT id, org_id, staff_id, staff_since, staff_seen_at FROM scanners ORDER BY id',
    ),
    audits: await all(
      env.DB,
      "SELECT * FROM audit_log WHERE action LIKE 'scan_staff.%' ORDER BY id",
    ),
  };
}

/** Simulate out-of-band keyset corruption between capture and the final statement. */
export async function forceStaffTenantKeyset(env: Pick<AppEnv, 'DB'>, commitment: string) {
  await withoutTrigger(env.DB, 'credential_ref_keyset_no_update', async () => {
    await run(env.DB, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [commitment]);
  });
}
