import { afterEach, beforeEach } from 'vitest';
import { createFakeIdp, type FakeIdp, installFakeIdp } from '../../../../test/helpers/fake-idp.ts';
import { fixtures, makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { type OperationDto, OperationSchema } from '../../../shared/contracts/operations.ts';
import { run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { harness, type TestHarness } from '../auth/test-support.ts';
import { captureQueue } from '../developer/sandbox-test-fixtures.ts';
import { handleOperationRun } from '../operations/jobs.ts';
import { clearMarks, membership, type Person } from './access-test-fixtures.ts';
import { holdTarget } from './repo-state.ts';

/** The harness, the fake Polaris ID and the queue of the running test: `installOpsRig()` sets them before each one. */
export const rig = {} as { h: TestHarness; idp: FakeIdp; queue: ReturnType<typeof captureQueue> };
export const f = () => fixtures(rig.h.env, rig.h.clock);

export function installOpsRig(): void {
  beforeEach(async () => {
    rig.h = await harness();
    // The file's D1 lasts across tests: an operation left active would block the next start.
    await run(rig.h.env.DB, 'DELETE FROM operations');
    await run(rig.h.env.DB, 'DELETE FROM idp_run_lease');
    rig.idp = createFakeIdp({ now: () => rig.h.clock.now() });
    installFakeIdp(rig.h.env, rig.idp);
    rig.queue = captureQueue();
    Object.assign(rig.h.env, { JOBS: rig.queue.binding });
    (rig.h.env as { RL_REFRESH: unknown }).RL_REFRESH = { limit: async () => ({ success: true }) };
  });
  afterEach(() => rig.h.restore());
}

export async function admin(roles: ('admin' | 'user')[] = ['admin', 'user'], amr?: 'magic_link') {
  const user = await makeUser(f());
  const session = await makeSession(f(), { userId: user.id, roles, ...(amr ? { amr } : {}) });
  // The run reads the user row: it checks the starter is still an admin.
  if (roles.includes('admin'))
    await run(rig.h.env.DB, 'UPDATE users SET last_roles = ? WHERE id = ?', [
      JSON.stringify(roles),
      user.id,
    ]);
  return { user, headers: session.headers };
}

/** A user whose console role PassBook added and the owner took away: paused, and still wanted by a membership. */
export async function paused(role: 'console' = 'console') {
  const user = await makeUser(f());
  const subject = `sub-${user.id}`;
  await run(
    rig.h.env.DB,
    "INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('pocketid', ?, ?, 0)",
    [subject, user.id],
  );
  const org = await makeOrg(f());
  const p: Person = { id: user.id, email: user.primaryEmail, subject };
  await membership(f(), org.id, p, ['org_admin'], user.primaryEmail);
  await clearMarks([subject]);
  rig.idp.addAccount(subject, { class: 'linked' });
  await holdTarget(rig.h.env.DB, subject, role, user.id, rig.h.clock.now());
  return { user, subject, role };
}

export const start = async (
  path: string,
  method: string,
  headers: Record<string, string>,
  json?: unknown,
) => rig.h.call(path, { method, headers, ...(json === undefined ? {} : { json }) });

export const opOf = async (res: Response) =>
  OperationSchema.parse(((await res.json()) as { operation: unknown }).operation);

/** Runs the `operation.run` job the start queued. */
export async function runNext(op: OperationDto) {
  await handleOperationRun(
    { kind: 'operation.run', operationId: op.id, attempt: op.attempt },
    createJobContext(rig.h.env, 'test', { clock: rig.h.clock }),
  );
}

export const read = async (id: string, headers: Record<string, string>) =>
  OperationSchema.parse(await (await rig.h.call(`/api/v1/operations/${id}`, { headers })).json());
