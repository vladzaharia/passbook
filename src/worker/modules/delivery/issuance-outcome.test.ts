import { beforeAll, describe, expect, it } from 'vitest';
import { saveOrgSettings } from '../../../../test/helpers/index.ts';
import { PassDetailSchema } from '../../../shared/contracts/passes.ts';
import { run } from '../../platform/db.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { issuanceEmailOutcome } from './issuance-outcome.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});
const save = (values: Record<string, unknown>) =>
  saveOrgSettings(kit.ctx.env.DB, kit.org.id, values, kit.ctx.clock.now());
const issue = (to: string | null) =>
  createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: kit.template.version,
    input: { memberName: 'Outcome' },
    ...(to ? { holderEmail: to, sendEmail: true } : {}),
    source: 'manual',
    mode: 'live',
    actor: { type: 'system', id: null },
    execution: { kind: 'system' },
  });
const outcome = async (to: string | null) =>
  issuanceEmailOutcome(jobCtxOf(kit), (await issue(to)).id);

describe('issuance email outcome', () => {
  it('is none without an email', async () => {
    expect(await outcome(null)).toEqual({ outcome: 'none' });
  });
  it('is queued when the email was queued', async () => {
    expect(await outcome('first@example.com')).toEqual({ outcome: 'queued' });
  });
  it('is limited_recipient once the hourly cap is used', async () => {
    await save({ 'email.recipientCapPerHour': 1 });
    await outcome('same@example.com');
    expect(await outcome('same@example.com')).toEqual({
      outcome: 'limited_recipient',
      cap: 'recipient',
    });
    await save({ 'email.recipientCapPerHour': null });
  });
  it('is cancelled when the intent was cancelled', async () => {
    await save({ 'email.recipientCapPerHour': 1 });
    await issue('gone@example.com');
    const pass = await issue('gone@example.com');
    await run(
      kit.env.DB,
      "UPDATE pass_issuance_deliveries SET state = 'cancelled', error_code = 'DELIVERY_STALE' WHERE pass_id = ?",
      [pass.id],
    );
    await save({ 'email.recipientCapPerHour': null });
    expect(await issuanceEmailOutcome(jobCtxOf(kit), pass.id)).toEqual({ outcome: 'cancelled' });
  });
  it('is limited_org once the daily cap is used', async () => {
    kit = await setupKit();
    await save({ 'email.orgCapPerDay': 10 });
    for (let i = 0; i < 10; i++) await outcome(`org-${i}@example.com`);
    expect(await outcome('org-late@example.com')).toEqual({ outcome: 'limited_org', cap: 'org' });
  });
});

describe('create response field', () => {
  it('is optional and carries outcome and cap', () => {
    const base = { outcome: 'limited_org', cap: 'org' } as const;
    const shape = PassDetailSchema.shape.email;
    expect(shape.parse(undefined)).toBeUndefined();
    expect(shape.parse(base)).toEqual(base);
    expect(shape.safeParse({ outcome: 'nope' }).success).toBe(false);
  });
});
