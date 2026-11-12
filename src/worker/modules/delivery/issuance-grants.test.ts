import { beforeAll, describe, expect, it } from 'vitest';
import { jobGrant } from '../../platform/authority.ts';
import { first } from '../../platform/db.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { NewPassRow } from '../passes/repo-write-types.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { grantIssuanceInsert, grantTransferFinish, grantTransferStart } from './repo-issuance.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const grantFor = (orgId: string) =>
  jobGrant(jobCtxOf(kit), {
    job: 'test',
    purpose: 'org_mode.job.issuance_test',
    orgId,
    mode: 'live',
  });

async function delivery(passId: string) {
  return first<{
    state: string;
    outbox_id: string | null;
    error_code: string | null;
    context: string;
  }>(
    kit.env.DB,
    'SELECT state, outbox_id, error_code, context FROM pass_issuance_deliveries WHERE pass_id = ?',
    [passId],
  );
}

describe('issuance statements in a grant', () => {
  it('inserts from the pass row in the tenant, pins the epochs, and cancels at START', async () => {
    const pass = await kit.pass({ holderEmail: 'grant-issue@example.com' });
    const row = {
      id: pass.id,
      orgId: pass.orgId,
      mode: 'live',
      holderEmail: pass.holderEmail,
      execution: { kind: 'system' },
      release: { id: 'r', generation: 1, orgId: null, provider: 'apple' },
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      connectionId: null,
      connectionGeneration: null,
      externalRef: null,
      now: kit.clock.now(),
    } as unknown as NewPassRow;
    const g = grantFor(pass.orgId);
    const insert = await grantIssuanceInsert(kit.env.DB, g, row);
    expect(insert).toBeDefined();
    const [written] = await g.commit();
    expect(written?.results).toHaveLength(1);
    const stored = await delivery(pass.id);
    expect(stored).toMatchObject({ state: 'pending', outbox_id: null });
    expect(JSON.parse(stored?.context ?? '{}').orgRevision).toBeGreaterThan(0);

    const start = grantFor(pass.orgId);
    grantTransferStart(start, {
      passId: pass.id,
      transferId: 'no-transfer',
      now: kit.clock.now(),
      verifiedAttach: false,
    });
    await start.commit();
    expect(await delivery(pass.id)).toMatchObject({
      state: 'cancelled',
      error_code: 'DELIVERY_STALE',
    });

    const finish = grantFor(pass.orgId);
    grantTransferFinish(finish, { passId: pass.id, transferId: 'no-transfer', objectKey: 'k' });
    const [done] = await finish.commit();
    expect(done?.results).toHaveLength(0);
  });

  it('inserts nothing when the pass row is not in the grant tenant', async () => {
    const pass = await kit.pass({ holderEmail: 'grant-other@example.com' });
    const row = {
      id: pass.id,
      orgId: pass.orgId,
      mode: 'live',
      holderEmail: pass.holderEmail,
      execution: { kind: 'system' },
      release: { id: 'r', generation: 1, orgId: null, provider: 'apple' },
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      connectionId: null,
      connectionGeneration: null,
      externalRef: null,
      now: kit.clock.now(),
    } as unknown as NewPassRow;
    const g = grantFor(pass.orgId);
    await grantIssuanceInsert(kit.env.DB, g, { ...row, holderEmail: 'someone-else@example.com' });
    const [written] = await g.commit();
    expect(written?.results).toHaveLength(0);
    expect(await delivery(pass.id)).toBeNull();
  });
});
