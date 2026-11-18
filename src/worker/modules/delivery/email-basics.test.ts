import { beforeAll, describe, expect, it } from 'vitest';
import { makeTemplate, saveOrgSettings } from '../../../../test/helpers/index.ts';
import { EMAIL_LIMIT_COPY } from '../../../shared/copy/email.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { enqueuePassEmail } from './issuance-intent.ts';
import { handleEmailSend } from './jobs.ts';
import { confirmReplyTo, syncReplyTo } from './reply-to.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit({
    template: (id) => {
      const t = makeTemplate({ id });
      t.resolved.manifest.email = { subject: 'Welcome, {{memberName}}' };
      return t;
    },
  });
});
const job = () => jobCtxOf(kit);
const save = (values: Record<string, unknown>) =>
  saveOrgSettings(kit.ctx.env.DB, kit.org.id, values, kit.ctx.clock.now());

let n = 0;
async function send(to = `holder-${++n}@example.com`) {
  const source = await kit.pass();
  const pass = await getPass(kit.env.DB, source.id);
  if (!pass) throw new Error('pass missing');
  const { outboxId } = await enqueuePassEmail(job(), {
    passId: pass.id,
    to,
    attach: false,
    expected: pass,
  });
  await handleEmailSend({ kind: 'email.send', outboxId }, job());
  const sent = kit.mailer.sent.at(-1);
  if (!sent) throw new Error('nothing sent');
  return sent;
}

describe('org From name and reply-to', () => {
  it('defaults to "<Org> via <platform>" with no reply-to without a support address', async () => {
    const sent = await send();
    expect(sent.fromName).toBe('Test Gym via PassBook');
    expect(sent.replyTo).toBeUndefined();
  });
  it('uses the org name and its support address as reply-to', async () => {
    await save({ 'email.fromName': 'Harbor Gym', 'support.email': 'help@harbor.test' });
    const before = await send();
    expect(before.fromName).toBe('Harbor Gym via PassBook');
    expect(before.replyTo).toBeUndefined();
    await syncReplyTo(kit.ctx, kit.org.id, 'help@harbor.test');
    const token = /confirmReplyTo=([\w-]+)/.exec(kit.mailer.sent.at(-1)?.text ?? '')?.[1] ?? '';
    await confirmReplyTo(kit.ctx, kit.org.id, token);
    expect((await send()).replyTo).toBe('help@harbor.test');
  });
  it('ignores a stored name that now impersonates the platform', async () => {
    await save({ 'email.fromName': 'Harbor Gym' });
    await kit.env.DB.prepare(
      "UPDATE settings SET value = '\"PassBook Support\"' WHERE scope = ? AND key = 'email.fromName'",
    )
      .bind(`org:${kit.org.id}`)
      .run();
    const { clearSettingsCache } = await import('../settings/service.ts');
    clearSettingsCache(kit.env.DB);
    expect((await send()).fromName).toBe('Test Gym via PassBook');
    await save({ 'email.fromName': null });
  });
});

describe('template subject', () => {
  it('renders the template subject with the pass input', async () => {
    const sent = await send();
    expect(sent.subject).toMatch(/^Welcome, .+/);
    expect(sent.subject).not.toContain('Your Test Gym pass');
  });
});

describe('caps from settings', () => {
  it('uses the org recipient cap and names the limit', async () => {
    await save({ 'email.recipientCapPerHour': 1 });
    const to = 'capped@example.com';
    await send(to);
    await expect(send(to)).rejects.toMatchObject({
      code: 'EMAIL_RATE_LIMITED',
      message: EMAIL_LIMIT_COPY.recipient,
      issues: [{ path: 'limit', message: 'recipient' }],
    });
    await save({ 'email.recipientCapPerHour': null });
  });
  it('uses the org daily cap and says the rest send tomorrow', async () => {
    kit = await setupKit();
    await save({ 'email.orgCapPerDay': 10 });
    const to = (i: number) => `day-${i}@example.com`;
    for (let i = 0; i < 10; i++) await send(to(i));
    await expect(send(to(99))).rejects.toMatchObject({
      code: 'EMAIL_RATE_LIMITED',
      message: 'Daily email limit reached. The rest send tomorrow.',
      issues: [{ path: 'limit', message: 'org' }],
    });
  });
});
