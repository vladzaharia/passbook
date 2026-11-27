import { beforeAll, describe, expect, it } from 'vitest';
import { countD1, makeUser } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { resetDeps, setDeps } from './deps.ts';
import { inlineStep, seedConnectionWorkflow } from './runtime-fixtures.ts';
import * as service from './service.ts';
import { executeSync } from './sync-runner.ts';
import { publicResolver } from './test-kit.ts';

let kit: Kit;
let commitment: string;
beforeAll(async () => {
  kit = await setupKit();
  commitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  await makeUser(kit.fx, { id: 'admin-1' });
  resetDeps();
  setDeps({ sleep: async () => {}, resolver: publicResolver });
});

describe('connection sync round trips', () => {
  it('republishing one changed pass stays within its trip budget', async () => {
    const ctx = createJobContext(kit.env, 'trips-test', { clock: kit.clock, log: kit.ctx.log });
    const actor = { type: 'user', id: 'admin-1' } as const;
    const dto = await service.create(ctx, actor, {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Demo',
      config: { count: 1 },
      mode: 'poll',
      mapping: { memberName: { from: '/memberName' } },
      autoCreate: true,
      defaultTemplateId: kit.template.id,
    } as never);
    const run = async (generation: number, id: string) => {
      const params = {
        connectionId: dto.id,
        orgId: kit.org.id,
        generation,
        credentialKeysetCommitment: commitment,
        trigger: 'schedule' as const,
        runId: id,
        instanceId: id,
      };
      await seedConnectionWorkflow(ctx, params);
      await executeSync(ctx, inlineStep(), params);
    };
    await run(1, 'trips-1');
    await kit.settle();
    await service.update(ctx, actor, dto.id, {
      mapping: { memberName: { from: '/memberName', transform: { kind: 'upper' } } },
      config: { count: 1, revision: 1 },
    });
    const original = kit.env.DB;
    const counted = countD1(original);
    Object.assign(kit.env, { DB: counted.db });
    try {
      await run(2, 'trips-2');
    } finally {
      Object.assign(kit.env, { DB: original });
    }
    const row = await first<{ version: number }>(
      kit.env.DB,
      'SELECT version FROM passes WHERE connection_id = ?',
      [dto.id],
    );
    expect(row?.version).toBe(2);
    const log = counted.tripLog();
    const heads = `\n${log.map((t) => `[${t.length}] ${t[0]?.replace(/\s+/g, ' ').slice(0, 40)}`).join('\n')}`;
    // The whole sync run (run bookkeeping, connection and org fences, the listing, the publish): a ceiling
    // that catches a regression, not a goal.
    expect(counted.count(), heads).toBeLessThanOrEqual(80);
    // The publish reads its pass state in the one bundle trip, not as single reads.
    const singles = log.filter(
      (t) =>
        t.length === 1 &&
        /FROM pass_personalizations|FROM pass_versions WHERE pass_id = \? ORDER BY version DESC|FROM signing_identities|FROM pass_assets/.test(
          t[0] ?? '',
        ),
    );
    expect(singles, heads).toEqual([]);
    expect(log.filter((t) => t[0]?.startsWith('SELECT removal_message')).length).toBe(1);
  });
});
