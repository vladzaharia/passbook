import { describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { beginTransfer, interveneAtD1 } from './credential-transfer-test-fixtures.ts';

const TYPE = 'pass.im.plrs.wallet';
// Storage lasts for the whole file; the credential keyset is immutable, so each case gets its own D1.
const makeEnv = installKeysetTestEnv();
const body = JSON.stringify({
  personalizationToken: 'wallet-personalization-token',
  requiredPersonalizationInfo: { fullName: 'Old Holder', emailAddress: 'old@example.test' },
});

async function personalizableFixture() {
  const kit = await setupKit({ db: (await makeEnv()).DB });
  kit.env.KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const icon = new Uint8Array(
    await new Response(await kit.registry.openAsset(kit.template, 'icon.png')).arrayBuffer(),
  );
  const template = kit.registry.add({
    id: `personalizable-${kit.ctx.ids.token(8)}`,
    orgId: kit.template.orgId,
    version: kit.template.version,
    manifest: kit.template.manifest,
    passJson: kit.template.passJson,
    assets: {
      'icon.png': icon,
      'personalizationLogo.png': icon,
      'personalization.json': new TextEncoder().encode(
        JSON.stringify({
          description: 'Join',
          requiredPersonalizationFields: [
            'PKPassPersonalizationFieldName',
            'PKPassPersonalizationFieldEmailAddress',
          ],
        }),
      ),
    },
  });
  await persistTemplate(kit.fx, template, { registry: kit.registry });
  const apple = await approveAppleRelease(kit, {
    templateId: template.id,
    version: template.version,
  });
  // The build refuses personalization.json unless the signing identity is NFC-entitled.
  await run(kit.env.DB, 'UPDATE signing_identities SET nfc_enabled = 1 WHERE 1 = 1');
  const pass = await createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: template.id,
    templateVersion: apple.version,
    releaseId: apple.id,
    releaseGeneration: apple.generation,
    input: { memberName: 'Alex Morgan' },
    holderEmail: null,
    source: 'manual',
    mode: 'live',
    execution: { kind: 'system' },
    actor: { type: 'system', id: null },
  });
  kit.template = template;
  await run(kit.env.DB, 'UPDATE signing_identities SET nfc_enabled = 1 WHERE id = ?', [
    pass.identityId,
  ]);
  return { kit, pass, apple, barcode: 'none' as const };
}

/** Start a transfer whose finish fails at the artifact upload, so it stays pending (providers are dark). */
async function beginPendingTransfer(kit: Kit, pass: Pass) {
  const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
  const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, value, options) => {
    if (key.startsWith(`passes/${pass.id}/`)) throw new Error('Artifact upload deferred');
    return original(key, value, options);
  });
  try {
    return await beginTransfer(kit, pass);
  } finally {
    spy.mockRestore();
  }
}

function post(kit: Kit, pass: Pass, env: AppEnv = kit.env, payload = body) {
  return createApp({ clock: kit.clock }).request(
    `https://wallet.test/wallet/v1/passes/${TYPE}/${pass.serial}/personalize`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload },
    env,
  );
}

describe('Apple personalization transfer fence', () => {
  it('removes old encrypted personalization and refuses the old serial while pending', async () => {
    const { kit, pass } = await personalizableFixture();
    expect((await post(kit, pass)).status).toBe(200);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_personalizations WHERE pass_id = ?', [pass.id]),
    ).not.toBeNull();
    expect((await beginPendingTransfer(kit, pass)).state).toBe('pending');
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_personalizations WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
    expect((await post(kit, pass)).status).toBe(404);
  }, 120_000);

  it('cannot insert old holder data if transfer starts before the real D1 insert', async () => {
    const { kit, pass } = await personalizableFixture();
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'batch',
        sql: /INSERT OR IGNORE INTO pass_personalizations/i,
        when: 'before',
      },
      async () => {
        expect((await beginPendingTransfer(kit, pass)).state).toBe('pending');
      },
    );
    const response = await post(kit, pass, { ...kit.env, DB: gate.db } as AppEnv);
    expect(gate.hits()).toBe(1);
    expect(response.status).toBe(404);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_personalizations WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'pass.personalized'",
        [pass.id],
      ),
    ).toBeNull();
    expect((await getPass(kit.env.DB, pass.id))?.version).toBe(pass.version);
  }, 120_000);

  it('does not mark personalization published after transfer has started', async () => {
    const { kit, pass } = await personalizableFixture();
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'batch',
        sql: /UPDATE pass_personalizations SET published_at/i,
        when: 'before',
      },
      async () => {
        expect((await beginPendingTransfer(kit, pass)).state).toBe('pending');
      },
    );
    const response = await post(kit, pass, { ...kit.env, DB: gate.db } as AppEnv);
    expect(gate.hits()).toBe(1);
    expect(response.status).toBe(404);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_personalizations WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
  }, 120_000);

  it('does not sign a retry after its already-personalized serial is retired', async () => {
    const { kit, pass } = await personalizableFixture();
    expect((await post(kit, pass)).status).toBe(200);
    const current = await getPass(kit.env.DB, pass.id);
    if (!current) throw new Error('Missing personalized pass');
    const gate = interveneAtD1(
      kit.env.DB,
      {
        method: 'first',
        sql: /^\s*SELECT 1 FROM passes p WHERE p\.id = \?/i,
        when: 'before',
        occurrence: 3,
      },
      async () => {
        expect((await beginPendingTransfer(kit, current)).state).toBe('pending');
      },
    );
    const response = await post(kit, current, { ...kit.env, DB: gate.db } as AppEnv);
    expect(gate.hits()).toBe(1);
    expect(response.status).toBe(404);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_personalizations WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
  }, 120_000);

  it('allows the new serial to personalize independently after completion', async () => {
    const { kit, pass: old } = await personalizableFixture();
    expect((await post(kit, old)).status).toBe(200);
    expect((await beginTransfer(kit, old)).state).toBe('completed');
    const fresh = await getPass(kit.env.DB, old.id);
    if (!fresh) throw new Error('Missing transferred pass');
    expect(fresh.templateVersion).toBe(old.templateVersion);
    expect(fresh.releaseId).toBe(old.releaseId);
    expect(fresh.serial).not.toBe(old.serial);
    expect((await post(kit, old)).status).toBe(404);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_personalizations WHERE pass_id = ?', [old.id]),
    ).toBeNull();
    const token = 'new-wallet-token';
    const response = await post(
      kit,
      fresh,
      kit.env,
      JSON.stringify({
        personalizationToken: token,
        requiredPersonalizationInfo: { fullName: 'New Holder', emailAddress: 'new@example.test' },
      }),
    );
    expect(response.status).toBe(200);
    expect(
      await first(kit.env.DB, 'SELECT token_sha256 FROM pass_personalizations WHERE pass_id = ?', [
        old.id,
      ]),
    ).toEqual({ token_sha256: await sha256Hex(token) });
  }, 120_000);
});
