import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession } from '../../../../test/helpers/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { toDto } from '../operations/dto.ts';
import { rowById } from '../operations/repo.ts';
import { authorizeConnection, type ConnectionAuthority } from './access.ts';
import * as actions from './actions.ts';
import { operationRunners } from './operations.ts';
import { getConnection } from './repo.ts';
import { inlineStep, seedConnectionWorkflow } from './runtime-fixtures.ts';
import { executeSync, type SyncRunParams } from './sync-runner.ts';
import { addMembership, createDemo, type Kit, makeKit, withWorkflow } from './test-kit.ts';

let kit: Kit;
let authority: ConnectionAuthority;
let session: SessionAuth;
beforeEach(async () => {
  kit = await makeKit();
  await addMembership(kit, kit.actor.id, ['integration_admin']);
  const fixture = await makeSession(kit, { userId: kit.actor.id });
  session = (await createSessionStore(kit.env, kit.clock).resolve(
    fixture.cookieValue,
  )) as SessionAuth;
  authority = await authorizeConnection(kit.sctx, session, kit.org.id, 'integrations:manage');
});

const opOf = async (id: string) => toDto((await rowById(kit.env.DB, id)) as never);

async function startSync() {
  const dto = await createDemo(kit);
  const wf = withWorkflow(kit, undefined, () => 'running');
  let operationId = '';
  const run = await actions.syncNow(wf.sctx, kit.actor, dto.id, authority, undefined, {
    actor: { type: 'user', id: kit.actor.id },
    onStarted: (op) => {
      operationId = op.id;
    },
  });
  return { dto, wf, run, operationId };
}

describe('Sync now shows as an operation', () => {
  it('makes the operation before the Workflow and hands it the ids', async () => {
    const { dto, wf, run, operationId } = await startSync();
    expect(operationId).not.toBe('');
    expect(await opOf(operationId)).toMatchObject({
      kind: 'connection.sync',
      status: 'queued',
      orgId: kit.org.id,
      target: { type: 'connection', id: dto.id },
    });
    expect(wf.created[0]?.id).toBe(run.workflowInstanceId);
    expect(wf.created[0]?.params).toMatchObject({ operationId, operationAttempt: 1 });
  });

  it('counts the records and ends Done when the run closes', async () => {
    const { dto, wf, operationId } = await startSync();
    const conn = await getConnection(kit.env.DB, dto.id);
    const params = {
      ...(wf.created[0]?.params as object),
      generation: conn?.generation ?? 1,
      instanceId: wf.created[0]?.id,
    } as SyncRunParams;
    await seedConnectionWorkflow(kit.sctx, params);
    await executeSync(kit.sctx, inlineStep(), params);
    const op = await opOf(operationId);
    expect(op.status).toBe('succeeded');
    expect(op.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(op.steps[1]?.done).toBeGreaterThan(0);
    expect(JSON.stringify(op)).not.toMatch(/@/);
  });

  it('fails the operation when the run aborts, and Retry runs under an instance of its own', async () => {
    const { dto, wf, operationId } = await startSync();
    const conn = await getConnection(kit.env.DB, dto.id);
    const params = {
      ...(wf.created[0]?.params as object),
      generation: conn?.generation ?? 1,
      instanceId: wf.created[0]?.id,
    } as SyncRunParams;
    await seedConnectionWorkflow(kit.sctx, params);
    const step = inlineStep();
    const original = step.do.bind(step);
    step.do = (async (name: string, fn: () => Promise<unknown>) => {
      if (name === 'limits') throw new Error('boom');
      return original(name, fn as never);
    }) as typeof step.do;
    await expect(executeSync(kit.sctx, step, params)).rejects.toThrow('boom');
    const failed = await opOf(operationId);
    expect(failed).toMatchObject({ status: 'failed', error: { retryable: true } });
    // The run is closed, so a new sync may start: the retry names an instance after the operation.
    const relaunch = operationRunners['connection.sync']?.relaunch;
    const retry = withWorkflow(kit, undefined, () => 'running');
    const launched = await relaunch?.(
      retry.sctx,
      { ...failed, attempt: 2 },
      { instanceId: null },
      {
        ...session,
      },
    );
    expect(launched?.workflowInstanceId).toBe(retry.created[0]?.id);
    expect(retry.created[0]?.params).toMatchObject({ operationId, operationAttempt: 2 });
    expect(retry.created[0]?.id).not.toBe(wf.created[0]?.id);
  });
});
