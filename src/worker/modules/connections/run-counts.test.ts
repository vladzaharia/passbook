import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { type Kit as PassKit, setupKit } from '../passes/pass-test-fixtures.ts';
import { resetDeps, setDeps } from './deps.ts';
import { inlineStep, seedConnectionWorkflow } from './runtime-fixtures.ts';
import * as service from './service.ts';
import { executeSync } from './sync-runner.ts';
import { publicResolver } from './test-kit.ts';

let kit: PassKit & { keyset: string };
beforeAll(async () => {
  const local = await setupKit();
  const keyset = await ensureCredentialRefKeyset(local.env.DB, local.env);
  await makeUser(local.fx, { id: 'admin-1' });
  kit = {
    ...local,
    ctx: createJobContext(local.env, 'connection-test', { clock: local.clock, log: local.ctx.log }),
    keyset,
  };
  resetDeps();
  setDeps({ sleep: async () => {}, resolver: publicResolver });
});

let n = 0;
async function sync(connectionId: string, generation: number) {
  const id = `counts-${++n}`;
  const params = {
    connectionId,
    orgId: kit.org.id,
    generation,
    credentialKeysetCommitment: kit.keyset,
    trigger: 'schedule' as const,
    runId: id,
    instanceId: id,
  };
  await seedConnectionWorkflow(kit.ctx, params);
  await executeSync(kit.ctx, inlineStep(), params);
  return first<{ created: number; voided: number; failed: number; changed: number }>(
    kit.env.DB,
    `SELECT passes_created AS created, passes_voided AS voided, records_failed AS failed,
            passes_changed AS changed FROM connection_runs WHERE id = ?`,
    [id],
  );
}

describe('connection run counts', () => {
  it('records created, voided and failed passes of a run', async () => {
    const actor = { type: 'user', id: 'admin-1' } as const;
    const dto = await service.create(kit.ctx, actor, {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Counts',
      config: { count: 2 },
      mode: 'poll',
      mapping: { memberName: { from: '/memberName' } },
      autoCreate: true,
      defaultTemplateId: kit.template.id,
    } as never);
    expect(await sync(dto.id, 1)).toEqual({ created: 2, voided: 0, failed: 0, changed: 2 });
    await service.update(kit.ctx, actor, dto.id, {
      voidWhen: [{ from: '/memberName', op: 'present' }],
      config: { count: 2, revision: 1 },
    });
    expect(await sync(dto.id, 2)).toMatchObject({ created: 0, voided: 2, failed: 0 });
  });

  it('counts a record the template rejects as failed', async () => {
    const actor = { type: 'user', id: 'admin-1' } as const;
    const dto = await service.create(kit.ctx, actor, {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Failing',
      config: { count: 2 },
      mode: 'poll',
      mapping: { nothing: { from: '/memberName' } },
      autoCreate: true,
      defaultTemplateId: kit.template.id,
    } as never);
    expect(await sync(dto.id, 1)).toMatchObject({ created: 0, failed: 2 });
  });
});
