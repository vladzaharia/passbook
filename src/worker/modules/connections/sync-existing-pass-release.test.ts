import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { type Kit as PassKit, setupKit } from '../passes/pass-test-fixtures.ts';
import { resetDeps, setDeps } from './deps.ts';
import { inlineStep, seedConnectionWorkflow } from './runtime-fixtures.ts';
import * as service from './service.ts';
import { executeSync } from './sync-runner.ts';
import { publicResolver } from './test-kit.ts';

const actor = { type: 'user', id: 'admin-1' } as const;
let kit: PassKit & { credentialKeysetCommitment: string };
let n = 0;

beforeAll(async () => {
  const local = await setupKit();
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(local.env.DB, local.env);
  const ctx = createJobContext(local.env, 'connection-test', {
    clock: local.clock,
    log: local.ctx.log,
  });
  await makeUser(local.fx, { id: 'admin-1' });
  kit = { ...local, ctx, credentialKeysetCommitment };
  resetDeps();
  setDeps({ sleep: async () => {}, resolver: publicResolver });
}, 60_000);

async function sync(connectionId: string, generation: number) {
  const id = `existing-${++n}`;
  const params = {
    connectionId,
    orgId: kit.org.id,
    generation,
    credentialKeysetCommitment: kit.credentialKeysetCommitment,
    trigger: 'schedule' as const,
    runId: id,
    instanceId: id,
  };
  await seedConnectionWorkflow(kit.ctx, params);
  await executeSync(kit.ctx, inlineStep(), params);
}

describe('connection sync of an existing pass', () => {
  it('re-renders at the pass own version after its template is archived', async () => {
    const dto = await service.create(kit.ctx, actor, {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Demo',
      config: { count: 1 },
      mode: 'poll',
      mapping: { memberName: { from: '/memberName' } },
      autoCreate: true,
      defaultTemplateId: kit.template.id,
    } as never);
    await sync(dto.id, 1);
    await kit.settle();
    const before = await first<{ id: string; version: number; release_id: string | null }>(
      kit.env.DB,
      'SELECT id, version, release_id FROM passes WHERE connection_id = ?',
      [dto.id],
    );
    expect(before?.release_id).not.toBeNull();

    await run(kit.env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [
      kit.template.id,
    ]);
    await service.update(kit.ctx, actor, dto.id, {
      mapping: { memberName: { from: '/memberName', transform: { kind: 'upper' } } },
      config: { count: 1, revision: 1 },
    });
    await sync(dto.id, 2);
    await kit.settle();

    const after = await first<{
      version: number;
      release_id: string | null;
      personalization: string;
    }>(kit.env.DB, 'SELECT version, release_id, personalization FROM passes WHERE id = ?', [
      before?.id,
    ]);
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.release_id).toBe(before?.release_id);
    expect(JSON.parse(after?.personalization ?? '{}').memberName).toBe('MEMBER M-001');
    const pushes = await all(
      kit.env.DB,
      "SELECT 1 FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [before?.id],
    );
    expect(pushes.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
