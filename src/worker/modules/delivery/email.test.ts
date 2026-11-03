import { beforeAll, describe, expect, it } from 'vitest';
import { all } from '../../platform/db.ts';
import { baseUrl } from '../../platform/env.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { updateSettings } from '../settings/service.ts';
import { handleEmailSend } from './jobs.ts';
import { enqueuePassEmail } from './service.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const actor = { type: 'user' as const, id: 'admin-1' };

async function sendOne() {
  const pass = await kit.pass();
  const { outboxId } = await enqueuePassEmail(kit.ctx, {
    passId: pass.id,
    to: 'holder@example.com',
    attach: false,
  });
  await handleEmailSend({ kind: 'email.send', outboxId }, kit.ctx);
  const sent = kit.mailer.sent.at(-1);
  if (!sent) throw new Error('nothing sent');
  return sent;
}

describe('pass email buddy (email.buddy)', () => {
  it('is off by default, then follows the org setting, audited', async () => {
    const top = `${baseUrl(kit.env)}/email/buddy-happy-light-top-2x.png`;
    const off = await sendOne();
    expect(off.html).not.toContain('/email/buddy-');

    await updateSettings(kit.ctx, actor, {
      scope: `org:${kit.org.id}`,
      values: { 'email.buddy': true },
    });
    const on = await sendOne();
    expect(on.html).toContain(`src="${top}"`);
    expect(on.html).toContain('-legs-2x.png');
    // The words stay the org's: the plain-text part is the same with or without the buddy.
    expect(on.text.replace(/\/p\/[\w-]+/g, '/p/T')).toBe(off.text.replace(/\/p\/[\w-]+/g, '/p/T'));

    const audit = await all<{ org_id: string; detail: string }>(
      kit.env.DB,
      "SELECT org_id, detail FROM audit_log WHERE action = 'settings.update' AND target_id = ?",
      [`org:${kit.org.id}`],
    );
    expect(audit.map((r) => r.org_id)).toEqual([kit.org.id]);
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toEqual({
      changes: { 'email.buddy': { from: false, to: true } },
    });

    await updateSettings(kit.ctx, actor, {
      scope: `org:${kit.org.id}`,
      values: { 'email.buddy': null },
    });
    expect((await sendOne()).html).not.toContain('/email/buddy-');
  });
});
