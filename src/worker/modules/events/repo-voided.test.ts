import { describe, expect, it } from 'vitest';
import { recordAudit } from '../audit/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { recordPassEvent } from './record.ts';
import { voidedAt } from './repo-voided.ts';

describe('voidedAt', () => {
  it('reads the newest void event, else the audit row, else null', async () => {
    const kit = await setupKit();
    const ctx = jobCtxOf(kit);
    const pass = await kit.pass();
    const other = await kit.pass();
    expect(await voidedAt(kit.env.DB, pass.orgId, pass.id)).toBeNull();
    await recordAudit(ctx, {
      orgId: pass.orgId,
      actorType: 'system',
      actorId: null,
      action: 'pass.void',
      targetType: 'pass',
      targetId: pass.id,
    });
    const audited = await voidedAt(kit.env.DB, pass.orgId, pass.id);
    expect(audited).toBe(kit.clock.now());
    await recordPassEvent(ctx, {
      orgId: pass.orgId,
      passId: pass.id,
      mode: pass.mode,
      kind: 'pass.voided',
      at: 1_700_000_000_000,
    });
    expect(await voidedAt(kit.env.DB, pass.orgId, pass.id)).toBe(1_700_000_000_000);
    // Another org's id never reads this pass's rows.
    expect(await voidedAt(kit.env.DB, 'other-org', pass.id)).toBeNull();
    expect(await voidedAt(kit.env.DB, other.orgId, other.id)).toBeNull();
  });
});
