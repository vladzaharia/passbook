import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { handleEntitlementApply } from './entitlement-apply.ts';
import { type Job, legacy, planKit, trial } from './plan-apply-test-fixtures.ts';
import { levels } from './service.ts';

// Test-mode waiver (billing AD5): paper (print) and nfc are waived in Test; the wallets are not.

describe('channel levels in Test mode', () => {
  it('a trial blocks paper and nfc in Live only; google and samsung stay with the plan in both', async () => {
    const kit = await ruleKit();
    await run(kit.env.DB, 'UPDATE org_entitlements SET preset = ? WHERE org_id = ?', [
      'trial',
      kit.org.id,
    ]);
    const live = await levels(kit.ctx, kit.org.id, 'live');
    expect(live.entitlement).toMatchObject({ paper: 'not_included', nfc: 'not_included' });
    const test = await levels(kit.ctx, kit.org.id, 'test');
    expect(test.entitlement).toBeDefined();
    expect(test.entitlement?.paper).toBeUndefined();
    expect(test.entitlement?.nfc).toBeUndefined();
    for (const p of ['google', 'samsung'] as const)
      expect(test.entitlement?.[p]).toBe(live.entitlement?.[p]);
  });
});

describe('a plan change in Test mode', () => {
  it('records the Test run without the waived channels, and the Live run with them', async () => {
    const { t, ctx, change, planRuns } = await planKit(1);
    await t.passIn('test');
    const job = (await change(legacy, trial, 'trial')) as Job;
    expect(job.blockedAfter).toEqual(expect.arrayContaining(['paper', 'nfc']));
    await handleEntitlementApply(job, ctx);
    const byMode = Object.fromEntries((await planRuns()).map((r) => [r.mode, r]));
    expect(JSON.parse(byMode.live?.to_blocked as string)).toEqual(
      expect.arrayContaining(['paper', 'nfc']),
    );
    const test = JSON.parse(byMode.test?.to_blocked as string) as string[];
    expect(test).not.toContain('paper');
    expect(test).not.toContain('nfc');
    expect(JSON.parse(byMode.test?.from_blocked as string)).toEqual([]);
  });
});
