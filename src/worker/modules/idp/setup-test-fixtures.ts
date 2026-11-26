import { beforeEach } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { admin, installOpsRig, opOf, read, rig, runNext, start } from './ops-test-fixtures.ts';
import { resetScimTokenCache } from './scim-auth.ts';

export { admin, opOf, read, rig, runNext, start };

export const SETUP = '/api/v1/platform/idp/setup';

/** The rig, and a clean token table and directory mirror before each test (tokens retire before they go). */
export function installSetupRig(): void {
  installOpsRig();
  beforeEach(async () => {
    const db = rig.h.env.DB;
    await run(
      db,
      "UPDATE idp_scim_tokens SET state = 'retired', retired_at = 0 WHERE state != 'retired'",
    );
    for (const sql of [
      'DELETE FROM idp_scim_tokens',
      'DELETE FROM idp_directory_users',
      'DELETE FROM idp_directory_groups',
      "DELETE FROM audit_log WHERE action LIKE 'idp.setup%' OR action = 'idp.scim_rotate'",
    ])
      await run(db, sql);
    resetScimTokenCache();
  });
}

/** Starts a setup as an admin and runs its first job. */
export async function setupOnce(json?: unknown, headers?: Record<string, string>) {
  const a = headers ? { headers } : await admin();
  const op = await opOf(await start(SETUP, 'POST', a.headers, json ?? {}));
  await runNext(op);
  return { op, headers: a.headers, done: await read(op.id, a.headers) };
}

export const idsOf = (done: { result: { ids: Record<string, string> } | null }) =>
  done.result?.ids ?? {};

/** Marks the first push from Polaris ID with the active token, as the receiver does. */
export const pushSeen = () =>
  run(rig.h.env.DB, "UPDATE idp_scim_tokens SET last_auth_at = ? WHERE state = 'active'", [
    rig.h.clock.now(),
  ]);

export const activeCount = async () =>
  (
    await first<{ n: number }>(
      rig.h.env.DB,
      "SELECT COUNT(*) AS n FROM idp_scim_tokens WHERE state = 'active'",
    )
  )?.n ?? 0;
