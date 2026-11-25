import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { revealToken } from '../../platform/capability-token.ts';
import { all, first, run } from '../../platform/db.ts';
import { voidedVariant } from '../apple/variant.ts';
import { holderChannels } from '../channels/gate.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { handleEmailSend, handlePushDeliver } from '../delivery/jobs.ts';
import { syncReplyTo } from '../delivery/reply-to.ts';
import { enqueuePush } from '../delivery/service.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { linksOf } from '../passes/detail.ts';
import { servePassFile } from '../passes/file.ts';
import { packagePassObjects } from '../passes/package-objects.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { updatePass } from '../passes/service.ts';
import { openBody } from '../sandbox/captured-body.ts';
import { issueWalletOffer } from '../wallet-providers/offers.ts';
import {
  setWalletProvidersEnabledForTest,
  walletProviderDisabledReason,
} from '../wallet-providers/provider-policy.ts';
import { runtimeCredentialCurrent } from '../wallet-providers/runtime-core-credentials.ts';
import { assertNotPreviewOnly, PreviewOnlyError } from './fence.ts';
import { checkPreviewLink } from './preview-link.ts';

/**
 * The owner's invariant, run against the real entry points: a developer org's pass is never signed, minted,
 * pushed or mailed. `tools/developer-fence.test.ts` finds those entry points in the source and fails when one
 * has no fence; this file shows each fence refuses. A standard org beside it keeps every behaviour.
 */
let kit: Kit;
let dev: { id: string };
let std: { id: string };
let identityCalls: string[];
const A = 'a'.repeat(64);
const ORIGIN = 'https://passbook.mobile';

beforeAll(async () => {
  kit = await setupKit();
  // Any read of a signing identity by a developer org's pass is a finding.
  identityCalls = [];
  const real = depsOf(kit.env).identities;
  overrideDeps(kit.env, {
    identities: {
      async platform() {
        identityCalls.push('platform');
        return real.platform();
      },
      async byId(id) {
        identityCalls.push('byId');
        return real.byId(id);
      },
      async forOrg(orgId, identityId, now) {
        identityCalls.push('forOrg');
        return real.forOrg(orgId, identityId, now);
      },
      async byRow(row) {
        identityCalls.push('byRow');
        return real.byId(row.id);
      },
    },
  });
  dev = await makeOrg(kit.fx, { kind: 'developer', name: 'Dev Sandbox' });
  std = await makeOrg(kit.fx, { name: 'Standard Org' });
});

const job = () => jobCtxOf(kit);
const devPass = () => kit.pass({ orgId: dev.id, mode: 'test', holderEmail: 'dev@example.com' });
const stdPass = (mode: 'test' | 'live' = 'test') =>
  kit.pass({ orgId: std.id, mode, holderEmail: 'std@example.com' });

async function stored(pass: Pass) {
  const object = await kit.env.BUCKET.get(pass.objectKey);
  return new Uint8Array(await (object as R2ObjectBody).arrayBuffer());
}
const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;
const token = (pass: Pass) => revealToken(kit.env, 'pass', pass.id, pass.orgId, pass.downloadToken);

describe('sign', () => {
  it('builds a developer pass as JSON and reads no signing identity', async () => {
    identityCalls.length = 0;
    const pass = await devPass();
    const bytes = await stored(pass);
    expect(pass.objectKey).toMatch(/\.preview\.json$/);
    expect(isZip(bytes)).toBe(false);
    const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    expect(json.formatVersion).toBe(1);
    expect(json).not.toHaveProperty('authenticationToken');
    expect(await kit.env.BUCKET.head(pass.objectKey)).toMatchObject({
      httpMetadata: { contentType: 'application/json' },
    });
    expect(identityCalls).toEqual([]);
  });

  it('still signs a standard org, so the fence is what differs', async () => {
    const pass = await stdPass();
    expect(pass.objectKey).toMatch(/\.pkpass$/);
    expect(isZip(await stored(pass))).toBe(true);
  });

  it('keeps a developer pass unsigned when it is saved again', async () => {
    const pass = await devPass();
    const detail = await updatePass(
      job(),
      { type: 'system', id: null },
      pass.id,
      { input: { memberName: 'Sam Rivera' } },
      { scope: null },
    );
    expect(detail.version).toBe(2);
    const now = (await getPass(kit.env.DB, pass.id)) as Pass;
    expect(now.objectKey).toMatch(/\.preview\.json$/);
    expect(now.objectKey).not.toBe(pass.objectKey);
    expect(isZip(await stored(now))).toBe(false);
  });
});

describe('add to a wallet', () => {
  it('answers 409 SANDBOX_PREVIEW_ONLY at the file route and bundle, and links to the TEST preview', async () => {
    const pass = await devPass();
    const plain = await token(pass);
    const app = createApp({ clock: kit.clock });
    const res = await app.request(`${ORIGIN}/p/${plain}/pass.pkpass`, {}, kit.env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('SANDBOX_PREVIEW_ONLY');

    const links = await linksOf(kit.ctx, pass, plain);
    expect(links.downloadUrl.startsWith(`${ORIGIN}/preview/`)).toBe(true);
    expect(
      await checkPreviewLink(
        kit.env,
        links.downloadUrl.slice(`${ORIGIN}/preview/`.length),
        kit.clock.now(),
      ),
    ).toMatchObject({ state: 'ok', passId: pass.id });
    const standard = await stdPass();
    const stdLinks = await linksOf(kit.ctx, standard);
    expect(stdLinks.downloadUrl).toMatch(/\/pass\.pkpass$/);

    // The same pass cannot be served or packaged by any other route.
    await expect(servePassFile(kit.env.BUCKET, pass, new Request(ORIGIN))).rejects.toBeInstanceOf(
      PreviewOnlyError,
    );
    await expect(packagePassObjects(kit.ctx, [pass])).rejects.toBeInstanceOf(PreviewOnlyError);
  });

  it('offers no Apple copy: the channel reads as not included', async () => {
    const pass = await devPass();
    const channels = (await holderChannels(kit.ctx, pass)).effective;
    expect(channels.apple.on).toBe(false);
    expect(channels.google.on).toBe(false);
    expect(channels.samsung.on).toBe(false);
    expect((await holderChannels(kit.ctx, await stdPass())).effective.apple.on).toBe(true);
  });
});

describe('mint a Google or Samsung object', () => {
  it('refuses a developer org at the offer, the credential gate and the plan', async () => {
    const restore = setWalletProvidersEnabledForTest(true);
    try {
      const pass = await devPass();
      await expect(issueWalletOffer(kit.ctx, await token(pass), 'google')).rejects.toBeInstanceOf(
        PreviewOnlyError,
      );
      await expect(issueWalletOffer(kit.ctx, await token(pass), 'samsung')).rejects.toBeInstanceOf(
        PreviewOnlyError,
      );
      // Every provider credential read, hence every call out, passes this gate.
      const scope = { orgId: dev.id, mode: 'test' } as Parameters<
        typeof runtimeCredentialCurrent
      >[1];
      await expect(runtimeCredentialCurrent(kit.ctx, scope, 'google')).rejects.toBeInstanceOf(
        PreviewOnlyError,
      );
      await expect(runtimeCredentialCurrent(kit.ctx, scope, 'samsung')).rejects.toBeInstanceOf(
        PreviewOnlyError,
      );
      // An override that turns the wallet on in the plan does not open it.
      for (const key of ['wallet.google', 'wallet.samsung'])
        await run(
          kit.env.DB,
          `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
           VALUES (?, ?, '1', ?)`,
          [dev.id, key, kit.clock.now()],
        );
      expect(await walletProviderDisabledReason(kit.env.DB, 'google', dev.id, 'test')).toBe(
        'not_included',
      );
      expect(await walletProviderDisabledReason(kit.env.DB, 'samsung', dev.id, 'test')).toBe(
        'not_included',
      );
    } finally {
      restore();
    }
  });
});

describe('push', () => {
  it('sends no APNs request for a developer pass and cancels the push with a code', async () => {
    const pass = await devPass();
    await kit.device(pass, `dev-${pass.id}`, A);
    await enqueuePush(job(), pass.id, 'refresh');
    await kit.settle();
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' ORDER BY created_at DESC LIMIT 1",
      [pass.id],
    );
    const before = kit.apns.sent.length;
    await handlePushDeliver({ kind: 'push.deliver', outboxId: row?.id ?? '' }, kit.ctx);
    expect(kit.apns.sent.length).toBe(before);
    const after = await first<{ state: string; error_code: string | null }>(
      kit.env.DB,
      'SELECT state, error_code FROM outbox WHERE id = ?',
      [row?.id],
    );
    expect(after?.state).toBe('cancelled');
    expect(after?.error_code).toBe('SANDBOX_PREVIEW_ONLY');
  });

  it('still pushes for a standard org', async () => {
    const pass = await stdPass();
    await kit.device(pass, `std-${pass.id}`, 'b'.repeat(64));
    await enqueuePush(job(), pass.id, 'refresh');
    await kit.settle();
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' ORDER BY created_at DESC LIMIT 1",
      [pass.id],
    );
    const before = kit.apns.sent.length;
    await handlePushDeliver({ kind: 'push.deliver', outboxId: row?.id ?? '' }, kit.ctx);
    expect(kit.apns.sent.length).toBe(before + 1);
  });
});

describe('send mail', () => {
  it('lands in the Test inbox, never the mailer, and links to the TEST preview', async () => {
    const source = await devPass();
    const pass = (await getPass(kit.env.DB, source.id)) as Pass;
    const sent = kit.mailer.sent.length;
    const { outboxId } = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: 'holder@example.com',
      attach: false,
      expected: pass,
    });
    await handleEmailSend({ kind: 'email.send', outboxId }, job());
    const outbox = await first<{ state: string; error_code: string | null }>(
      kit.env.DB,
      'SELECT state, error_code FROM outbox WHERE id = ?',
      [outboxId],
    );
    expect(outbox, JSON.stringify(outbox)).toMatchObject({ state: 'sent' });
    expect(kit.mailer.sent.length).toBe(sent);
    const rows = await all<{ id: string; org_id: string; html: string; attached: number }>(
      kit.env.DB,
      'SELECT id, org_id, html, attached FROM captured_emails WHERE pass_id = ?',
      [pass.id],
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.attached).toBe(0);
    const html = await openBody(kit.env, row?.id ?? '', row?.org_id ?? '', row?.html ?? '');
    expect(html).toContain(`${ORIGIN}/preview/${pass.id}.`);
    expect(html).not.toContain('pass.pkpass');
  });

  it('refuses the reply-to confirmation mail for a developer org and sends it for a standard org', async () => {
    const before = kit.mailer.sent.length;
    await expect(syncReplyTo(kit.ctx, dev.id, 'help@dev.test')).rejects.toBeInstanceOf(
      PreviewOnlyError,
    );
    expect(kit.mailer.sent.length).toBe(before);
    await syncReplyTo(kit.ctx, std.id, 'help@std.test');
    expect(kit.mailer.sent.length).toBe(before + 1);
  });

  it('refuses a re-signed Apple copy of a developer pass', async () => {
    await expect(voidedVariant(kit.ctx, await devPass())).rejects.toBeInstanceOf(PreviewOnlyError);
  });

  it('refuses the real mailer for a developer org at every send site', async () => {
    await expect(assertNotPreviewOnly(kit.env.DB, dev.id)).rejects.toMatchObject({
      code: 'SANDBOX_PREVIEW_ONLY',
      status: 409,
    });
    await expect(assertNotPreviewOnly(kit.env.DB, std.id)).resolves.toBeUndefined();
  });
});
