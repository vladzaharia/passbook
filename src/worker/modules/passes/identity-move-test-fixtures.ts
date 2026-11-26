import { makeOrg, rememberAuthToken } from '../../../../test/helpers/index.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { first, run } from '../../platform/db.ts';
import { type BroadcastKit, broadcastKit } from '../broadcasts/test-kit.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { handleOperationRun } from '../operations/jobs.ts';
import { rowById } from '../operations/repo.ts';
import { SECOND_ID } from './identity-move-resolver-test-fixtures.ts';
import { startIdentityMove } from './identity-move-start.ts';
import type { Pass } from './repo.ts';
import { type MoveRow, moveById } from './repo-identity-move.ts';
import { getPass } from './repo-read-pass.ts';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const ADMIN = { userId: 'admin-1' };

export async function moveKit(): Promise<BroadcastKit> {
  const kit = await broadcastKit();
  await run(
    kit.env.DB,
    `INSERT OR IGNORE INTO signing_identities
       (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, created_at)
     VALUES (?, NULL, 'Second', 'pass.test.second', 'TEAM', 'env', 'TEST', ?)`,
    [SECOND_ID, kit.clock.now()],
  );
  return kit;
}

/** A new org with `n` Live passes on the platform identity, each with its own holder email. */
export async function orgWithPasses(kit: BroadcastKit, n: number, email = true) {
  const org = await makeOrg(kit.fx, { name: 'Move Gym' });
  const passes: Pass[] = [];
  for (let i = 0; i < n; i++)
    passes.push(
      await kit.makePass({
        orgId: org.id,
        ...(email
          ? { holderEmail: `holder${i}-${kit.fx.ids.token(4).toLowerCase()}@example.com` }
          : {}),
      }),
    );
  return { org, passes };
}

export const startMove = (kit: BroadcastKit, orgId: string, fromIdentityId = 'platform') =>
  startIdentityMove(jobCtxOf(kit), ADMIN, { orgId, fromIdentityId, toIdentityId: SECOND_ID });

export const runMove = (kit: BroadcastKit, op: OperationDto) =>
  handleOperationRun(
    { kind: 'operation.run', operationId: op.id, attempt: op.attempt },
    jobCtxOf(kit),
  );

export async function startAndRun(
  kit: BroadcastKit,
  orgId: string,
  fromIdentityId = 'platform',
): Promise<OperationDto> {
  const op = await startMove(kit, orgId, fromIdentityId);
  await runMove(kit, op);
  return op;
}

export async function opRow(kit: BroadcastKit, id: string) {
  const row = await rowById(kit.env.DB, id);
  if (!row) throw new Error('no operation');
  return row;
}

export async function moveOf(kit: BroadcastKit, oldPassId: string): Promise<MoveRow> {
  const row = await first<{ id: string }>(
    kit.env.DB,
    'SELECT id FROM pass_moves WHERE old_pass_id = ?',
    [oldPassId],
  );
  const move = row ? await moveById(kit.env.DB, row.id) : null;
  if (!move) throw new Error('no move row');
  return move;
}

export async function passOf(kit: BroadcastKit, id: string): Promise<Pass> {
  const pass = await getPass(kit.env.DB, id);
  if (!pass) throw new Error('no pass');
  return pass;
}

export async function replacement(kit: BroadcastKit, oldPass: Pass): Promise<Pass> {
  const move = await moveOf(kit, oldPass.id);
  return rememberAuthToken(kit.env, await passOf(kit, move.new_pass_id));
}

export const unregister = (kit: BroadcastKit, passId: string, deviceId: string) =>
  run(kit.env.DB, 'DELETE FROM registrations WHERE pass_id = ? AND device_id = ?', [
    passId,
    deviceId,
  ]);

export async function count(kit: BroadcastKit, sql: string, ...params: string[]) {
  return (await first<{ n: number }>(kit.env.DB, sql, params))?.n ?? 0;
}
