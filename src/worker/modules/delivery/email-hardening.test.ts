import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, saveOrgSettings } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { emailCaps, PLATFORM_RECIPIENT_HOURLY_CAP } from './email-limits.ts';
import { enqueuePassEmail } from './issuance-intent.ts';
import { issuanceEmailOutcome } from './issuance-outcome.ts';
import {
  confirmReplyTo,
  replyToFor,
  replyToStatus,
  resendReplyTo,
  syncReplyTo,
} from './reply-to.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});
const save = (orgId: string, values: Record<string, unknown>) =>
  saveOrgSettings(kit.ctx.env.DB, orgId, values, kit.ctx.clock.now());

async function queue(orgId: string, to: string) {
  const source = await kit.pass({ orgId });
  const pass = await getPass(kit.env.DB, source.id);
  if (!pass) throw new Error('pass missing');
  return enqueuePassEmail(jobCtxOf(kit), { passId: pass.id, to, attach: false, expected: pass });
}

describe('recipient cap is per org, with a platform ceiling', () => {
  it('one org at its cap does not block another org', async () => {
    const other = await makeOrg(kit.fx, { name: 'Other Gym' });
    await save(kit.org.id, { 'email.recipientCapPerHour': 1 });
    const to = 'shared-person@example.com';
    await queue(kit.org.id, to);
    await expect(queue(kit.org.id, to)).rejects.toMatchObject({ code: 'EMAIL_RATE_LIMITED' });
    await expect(queue(other.id, to)).resolves.toHaveProperty('outboxId');
  });

  it('over the platform ceiling the mail waits for the next hour, with no refusal', async () => {
    const orgs = [kit.org];
    for (let i = 0; i < 3; i++) orgs.push(await makeOrg(kit.fx, { name: `Org ${i}` }));
    for (const org of orgs) await save(org.id, { 'email.recipientCapPerHour': 20 });
    const to = 'popular@example.com';
    const now = kit.clock.now();
    const nextHour = now - (now % 3_600_000) + 3_600_000;
    const dueAt = async (outboxId: string) =>
      (
        await kit.env.DB.prepare('SELECT available_at FROM outbox WHERE id = ?')
          .bind(outboxId)
          .first<{ available_at: number }>()
      )?.available_at;
    for (let i = 0; i < PLATFORM_RECIPIENT_HOURLY_CAP; i++)
      expect(await dueAt((await queue((orgs[i % orgs.length] ?? kit.org).id, to)).outboxId)).toBe(
        0,
      );
    // The 11th and 12th, from different orgs, resolve (nothing for a tenant to read) and wait.
    for (const org of [orgs[0], orgs[1]])
      expect(await dueAt((await queue((org ?? kit.org).id, to)).outboxId)).toBe(nextHour);
  });

  it('reports a ceiling-deferred issuance email as deferred', async () => {
    const to = 'deferred-outcome@example.com';
    for (let i = 0; i < PLATFORM_RECIPIENT_HOURLY_CAP; i++) await queue(kit.org.id, to);
    await save(kit.org.id, { 'email.recipientCapPerHour': 20 });
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: kit.template.version,
      input: { memberName: 'Ceiling' },
      holderEmail: to,
      sendEmail: true,
      source: 'manual',
      mode: 'live',
      actor: { type: 'system', id: null },
      execution: { kind: 'system' },
    });
    expect(await issuanceEmailOutcome(kit.ctx, pass.id)).toEqual({ outcome: 'deferred' });
  });
});

describe('daily cap is clamped to the platform ceiling', () => {
  it('uses the smaller of the org value and the platform maximum', async () => {
    const org = await makeOrg(kit.fx, { name: 'Clamped' });
    await save(org.id, { 'email.orgCapPerDay': 5000 });
    clearSettingsCache(kit.env.DB);
    expect((await emailCaps(kit.ctx, org.id)).orgCap).toBe(500);
    await run(
      kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'email.orgCapPerDayMax', '40', NULL, 1)",
    );
    clearSettingsCache(kit.env.DB);
    expect((await emailCaps(kit.ctx, org.id)).orgCap).toBe(40);
    await run(
      kit.env.DB,
      "DELETE FROM settings WHERE scope = 'platform' AND key = 'email.orgCapPerDayMax'",
    );
    clearSettingsCache(kit.env.DB);
  });
});

describe('reply-to confirmation', () => {
  const tokenOf = () =>
    /confirmReplyTo=([\w-]+)/.exec(kit.mailer.sent.at(-1)?.text ?? '')?.[1] ?? '';

  it('is pending until the emailed link is used once', async () => {
    const org = await makeOrg(kit.fx, { name: 'Confirm Gym' });
    await save(org.id, { 'support.email': 'help@confirm.test' });
    clearSettingsCache(kit.env.DB);
    await syncReplyTo(kit.ctx, org.id, 'help@confirm.test');
    expect(kit.mailer.sent.at(-1)?.to).toBe('help@confirm.test');
    expect(await replyToStatus(kit.ctx, org.id)).toEqual({
      address: 'help@confirm.test',
      state: 'pending',
    });
    expect(await replyToFor(kit.ctx, org.id, 'help@confirm.test')).toBeUndefined();
    const token = tokenOf();
    await expect(confirmReplyTo(kit.ctx, org.id, `${token}x`)).rejects.toMatchObject({
      code: 'REPLY_TO_LINK_INVALID',
    });
    await confirmReplyTo(kit.ctx, org.id, token);
    expect((await replyToStatus(kit.ctx, org.id)).state).toBe('confirmed');
    expect(await replyToFor(kit.ctx, org.id, 'help@confirm.test')).toBe('help@confirm.test');
    await expect(confirmReplyTo(kit.ctx, org.id, token)).rejects.toMatchObject({
      code: 'REPLY_TO_LINK_INVALID',
    });
  });

  it('stores the token hashed and expires it after 24 hours', async () => {
    const org = await makeOrg(kit.fx, { name: 'Expiry Gym' });
    await save(org.id, { 'support.email': 'help@expiry.test' });
    clearSettingsCache(kit.env.DB);
    await syncReplyTo(kit.ctx, org.id, 'help@expiry.test');
    const token = tokenOf();
    const row = await kit.env.DB.prepare('SELECT token_hash FROM org_reply_to WHERE org_id = ?')
      .bind(org.id)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).not.toBe(token);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    kit.clock.advance(24 * 3_600_000 + 1);
    await expect(confirmReplyTo(kit.ctx, org.id, token)).rejects.toMatchObject({
      code: 'REPLY_TO_LINK_INVALID',
    });
  });

  it('a changed address drops the confirmation; clearing it removes the row', async () => {
    const org = await makeOrg(kit.fx, { name: 'Change Gym' });
    await save(org.id, { 'support.email': 'a@change.test' });
    clearSettingsCache(kit.env.DB);
    await syncReplyTo(kit.ctx, org.id, 'a@change.test');
    await confirmReplyTo(kit.ctx, org.id, tokenOf());
    await save(org.id, { 'support.email': 'b@change.test' });
    clearSettingsCache(kit.env.DB);
    await syncReplyTo(kit.ctx, org.id, 'b@change.test');
    expect(await replyToFor(kit.ctx, org.id, 'b@change.test')).toBeUndefined();
    expect(await replyToFor(kit.ctx, org.id, 'a@change.test')).toBeUndefined();
    await syncReplyTo(kit.ctx, org.id, null);
    expect(
      await kit.env.DB.prepare('SELECT 1 FROM org_reply_to WHERE org_id = ?').bind(org.id).first(),
    ).toBeNull();
  });

  it('rate-limits resend', async () => {
    const org = await makeOrg(kit.fx, { name: 'Resend Gym' });
    await save(org.id, { 'support.email': 'help@resend.test' });
    clearSettingsCache(kit.env.DB);
    await syncReplyTo(kit.ctx, org.id, 'help@resend.test');
    await expect(resendReplyTo(kit.ctx, org.id)).rejects.toMatchObject({
      code: 'REPLY_TO_RESEND_LIMITED',
    });
    kit.clock.advance(61_000);
    await resendReplyTo(kit.ctx, org.id);
    expect(kit.mailer.sent.at(-1)?.to).toBe('help@resend.test');
  });

  it('never uses a platform address, even when confirmed in the table', async () => {
    const org = await makeOrg(kit.fx, { name: 'Platform Gym' });
    const domain = (kit.env.EMAIL_FROM.match(/@([^>\s]+)/)?.[1] ?? 'passbook.mobile').toLowerCase();
    await run(
      kit.env.DB,
      'INSERT INTO org_reply_to (org_id, address, confirmed_at) VALUES (?, ?, 1)',
      [org.id, `x@${domain}`],
    );
    expect(await replyToFor(kit.ctx, org.id, `x@${domain}`)).toBeUndefined();
    expect(await replyToFor(kit.ctx, org.id, `x@mail.${domain}`)).toBeUndefined();
  });
});
