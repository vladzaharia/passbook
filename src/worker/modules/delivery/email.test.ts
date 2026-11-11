import { beforeAll, describe, expect, it, vi } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { baseUrl } from '../../platform/env.ts';
import { putPassAsset } from '../passes/asset-service.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { updateSettings } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { enqueuePassEmail } from './issuance-intent.ts';
import { handleEmailSend } from './jobs.ts';

const job = () => jobCtxOf(kit);

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const actor = { type: 'user' as const, id: 'admin-1' };

let sends = 0;

/** Each send to a new address, under the per-recipient hourly cap. */
async function sendOne(given?: Pass) {
  const source = given ?? (await kit.pass());
  const pass = await getPass(kit.env.DB, source.id);
  if (!pass) throw new Error('pass missing');
  const { outboxId } = await enqueuePassEmail(job(), {
    passId: pass.id,
    to: `holder-${++sends}@example.com`,
    attach: false,
    expected: pass,
  });
  await handleEmailSend({ kind: 'email.send', outboxId }, job());
  const sent = kit.mailer.sent.at(-1);
  if (!sent) throw new Error('nothing sent');
  return sent;
}

describe('pass email wallet availability', () => {
  it('sends the Apple action without native offers for an unconfigured account', async () => {
    const pass = await kit.pass();
    const { html, text } = await sendOne(pass);
    const base = baseUrl(kit.env);
    expect(html).toContain(`href="${base}/p/${pass.downloadToken}/pass.pkpass"`);
    expect(text).toContain(`Add to Apple Wallet: ${base}/p/${pass.downloadToken}/pass.pkpass`);
    expect(html).not.toContain('/icons/wallet-providers/');
    expect(text).not.toMatch(/Add to (Google|Samsung) Wallet/);
  });
});

describe('pass email buddy (email.buddy)', () => {
  it('is off by default, then follows the org setting, audited', async () => {
    const top = `${baseUrl(kit.env)}/email/buddy-m-happy-light-top-2x.png`;
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

describe("the pass's icon and logo", () => {
  const assets = (pass: Pass) => `${baseUrl(kit.env)}/p/${pass.downloadToken}/assets`;

  it('come from the public assets route with the pass token, fixed in size', async () => {
    const pass = await kit.pass();
    const plain = await sendOne(pass);
    // The kit template ships an icon and no logo.
    expect(plain.html).toContain(
      `<img src="${assets(pass)}/icon.png?v=${kit.template.version}" alt="" width="24" height="24"`,
    );
    expect(plain.html).not.toContain('/assets/logo');

    // An override at @2x: 200×60 px is 100×30 pt, under the email's 36.
    await putPassAsset(jobCtxOf(kit), actor, pass.id, 'logo@2x.png', makePng(200, 60), null);
    const { html } = await sendOne(pass);
    expect(html).toMatch(
      new RegExp(
        `<img src="${assets(pass)}/logo@2x\\.png\\?v=[0-9a-f]{40}" alt="${kit.org.name}" width="100" height="30"`,
      ),
    );
  });

  it("set the pass's logoText beside the logo unless the org's logo has the name", async () => {
    const pass = await kit.pass();
    await putPassAsset(jobCtxOf(kit), actor, pass.id, 'logo@2x.png', makePng(100, 100), null);
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.logoText', ?) WHERE pass_id = ?",
      [kit.org.name, pass.id],
    );
    const named = new RegExp(`font-weight:600;color:[^"]*">${kit.org.name}</td>`);
    expect((await sendOne(pass)).html).toMatch(named);
    await run(kit.env.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', [
      JSON.stringify({ logoHasName: true }),
      kit.org.id,
    ]);
    try {
      const { html } = await sendOne(pass);
      expect(html).not.toMatch(named);
      expect(html).toContain(`alt="${kit.org.name}" width="36" height="36"`);
    } finally {
      await run(kit.env.DB, "UPDATE orgs SET branding = '{}' WHERE id = ?", [kit.org.id]);
    }
  });

  it('leave the email to go without them when the template cannot be read', async () => {
    const pass = await kit.pass();
    const warn = vi.spyOn(kit.ctx.log, 'warn');
    const resolve = vi.spyOn(kit.registry, 'resolve').mockRejectedValue(new Error('D1 down'));
    try {
      const { html } = await sendOne(pass);
      expect(html).not.toContain('/assets/');
      expect(html).toContain('alt="Add to Apple Wallet"');
      expect(warn).toHaveBeenCalledWith(
        'email.images_failed',
        expect.objectContaining({ code: 'EMAIL_IMAGES' }),
      );
    } finally {
      resolve.mockRestore();
      warn.mockRestore();
    }
  });
});
