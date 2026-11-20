/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import migration from '../../../../migrations/0160_identities_managed.sql?raw';
import { deviceToken, fakeAuth } from '../../../../test/helpers/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { nullLogger } from '../../platform/log.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { handlePushDeliver } from '../delivery/jobs.ts';
import { enqueuePush } from '../delivery/service.ts';
import { createPassRow } from '../passes/create.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { updatePass } from '../passes/service.ts';
import { ensurePlatformIdentity } from './repo.ts';

const KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const fake = fakeAuth();
const TYPE = 'pass.im.plrs.wallet';

async function sharedIdentity(kit: Kit, passTypeIdentifier: string) {
  const f = await createFixtureIdentity({ passTypeIdentifier, teamIdentifier: 'ACME123456' });
  const env = { ...kit.env, SIGNER_PLATFORM_INTERMEDIATE: f.intermediate, KEK_V1 };
  const res = await createApp({ stores: fake.stores }).request(
    '/api/v1/identities',
    {
      method: 'POST',
      headers: { ...fake.admin(), 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'Shared',
        certificatePem: f.certificate,
        privateKeyPem: f.privateKey,
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  return { id: ((await res.json()) as { id: string }).id, env };
}

function create(kit: Kit, identityId: string, serial: string) {
  return createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: String(kit.liveRelease?.version ?? ''),
    releaseId: String(kit.liveRelease?.id ?? ''),
    releaseGeneration: kit.liveRelease?.generation ?? 1,
    input: { memberName: 'Alex Morgan' },
    holderEmail: null,
    source: 'manual',
    mode: 'live',
    execution: { kind: 'system' },
    actor: { type: 'system', id: null },
    identityId,
    serial,
  });
}

describe('signing identity guards', () => {
  it('aborts any change to the pass type or team and allows other updates', async () => {
    const kit = await setupKit();
    const { env } = kit;
    await run(env.DB, "UPDATE signing_identities SET label = 'Renamed' WHERE id = 'platform'");
    await expect(
      run(
        env.DB,
        "UPDATE signing_identities SET pass_type_identifier = 'pass.x.y' WHERE id = 'platform'",
      ),
    ).rejects.toThrow(/IDENTITY_PTI_IMMUTABLE/);
    await expect(
      run(
        env.DB,
        "UPDATE signing_identities SET team_identifier = 'OTHER12345' WHERE id = 'platform'",
      ),
    ).rejects.toThrow(/IDENTITY_PTI_IMMUTABLE/);
    await run(
      env.DB,
      "UPDATE signing_identities SET pass_type_identifier = pass_type_identifier WHERE id = 'platform'",
    );
  });

  it('generates the serial on any identity shared by orgs and lets the caller pick it on an org-owned one', async () => {
    const kit = await setupKit({ clockStart: Date.now() });
    const base = await depsOf(kit.env).identities.platform();
    await run(
      kit.env.DB,
      `INSERT INTO signing_identities (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, created_at)
       VALUES ('shared-2', NULL, 'Shared', 'pass.mobile.passbook.shared', ?, 'env', 'SHARED2', 1)`,
      [base.teamIdentifier],
    );
    let orgId: string | null = null;
    overrideDeps(kit.env, {
      identities: {
        ...depsOf(kit.env).identities,
        forOrg: async () => ({ ...base, id: 'shared-2', orgId }),
        byId: async () => ({ ...base, id: 'shared-2', orgId }),
      },
    });
    const shared = await create(kit, 'shared-2', 'chosen-serial');
    expect(shared.serial).not.toBe('chosen-serial');
    orgId = kit.org.id;
    const own = await create(kit, 'shared-2', 'chosen-serial');
    expect(own.serial).toBe('chosen-serial');
  });

  it('refuses new passes on a retired identity but keeps serving, updating and pushing issued ones', async () => {
    const kit = await setupKit({ clockStart: Date.now() });
    const pass = await kit.pass();
    await kit.device(pass, 'dev-1', 'a'.repeat(64));
    await run(kit.env.DB, "UPDATE signing_identities SET issuing = 0 WHERE id = 'platform'");
    try {
      await expect(kit.pass()).rejects.toMatchObject({ code: 'IDENTITY_RETIRED', status: 409 });

      kit.clock.advance(5000);
      await updatePass(
        jobCtxOf(kit),
        { type: 'system', id: null },
        pass.id,
        { input: { memberName: 'Newer' } },
        { scope: null },
      );
      await enqueuePush(jobCtxOf(kit), pass.id, 'refresh');
      await kit.settle();
      const outbox = await first<{ id: string }>(
        kit.env.DB,
        "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' ORDER BY created_at DESC LIMIT 1",
        [pass.id],
      );
      kit.apns.sent.length = 0;
      await handlePushDeliver({ kind: 'push.deliver', outboxId: outbox?.id ?? '' }, kit.ctx);
      expect(kit.apns.sent.some((s) => s.token === 'a'.repeat(64))).toBe(true);

      const res = await createApp({ stores: fake.stores }).request(
        `https://wallet.test/wallet/v1/passes/${TYPE}/${pass.serial}`,
        { headers: { authorization: `ApplePass ${deviceToken(pass)}` } },
        kit.env,
      );
      expect(res.status).toBe(200);
      expect((await getPass(kit.env.DB, pass.id))?.id).toBe(pass.id);
    } finally {
      await run(kit.env.DB, "UPDATE signing_identities SET issuing = 1 WHERE id = 'platform'");
    }
  });

  it('refuses new passes on an expired identity with IDENTITY_EXPIRED', async () => {
    const kit = await setupKit({ clockStart: Date.now() });
    const { not_after: notAfter } = (await first<{ not_after: number }>(
      kit.env.DB,
      "SELECT not_after FROM signing_identities WHERE id = 'platform'",
    )) ?? { not_after: 0 };
    await run(kit.env.DB, "UPDATE signing_identities SET not_after = ? WHERE id = 'platform'", [
      kit.clock.now() - 1,
    ]);
    try {
      await expect(kit.pass()).rejects.toMatchObject({ code: 'IDENTITY_EXPIRED', status: 409 });
    } finally {
      await run(kit.env.DB, "UPDATE signing_identities SET not_after = ? WHERE id = 'platform'", [
        notAfter,
      ]);
    }
  });
});

describe('certificate history backfill', () => {
  it('records each current certificate once, as active, with its origin and provenance', async () => {
    const kit = await setupKit({ clockStart: Date.now() });
    const shared = await sharedIdentity(kit, 'pass.com.acme.backfill');
    await ensurePlatformIdentity(kit.env, kit.clock.now(), nullLogger);
    await run(kit.env.DB, 'DELETE FROM identity_certificates');
    await run(kit.env.DB, "UPDATE signing_identities SET provenance = 'own'");
    // The statements a deploy runs over rows that predate the table.
    const sql = migration.slice(migration.indexOf('INSERT INTO identity_certificates'));
    await run(kit.env.DB, sql);
    await run(
      kit.env.DB,
      "UPDATE signing_identities SET provenance = 'platform' WHERE org_id IS NULL",
    );

    const rows = await all<{
      identity_id: string;
      origin: string;
      state: string;
      cert_sha256: string;
    }>(
      kit.env.DB,
      'SELECT identity_id, origin, state, cert_sha256 FROM identity_certificates ORDER BY identity_id',
    );
    const identities = await all<{ id: string; cert_sha256: string }>(
      kit.env.DB,
      'SELECT id, cert_sha256 FROM signing_identities WHERE cert_sha256 IS NOT NULL ORDER BY id',
    );
    expect(rows.map((r) => r.identity_id)).toEqual(identities.map((i) => i.id));
    expect(rows.every((r) => r.state === 'active')).toBe(true);
    expect(rows.find((r) => r.identity_id === 'platform')?.origin).toBe('env');
    expect(rows.find((r) => r.identity_id === shared.id)?.origin).toBe('upload');
    for (const r of rows)
      expect(r.cert_sha256).toBe(identities.find((i) => i.id === r.identity_id)?.cert_sha256);
  });

  it('allows one active certificate per identity', async () => {
    const kit = await setupKit();
    await ensurePlatformIdentity(kit.env, kit.clock.now(), nullLogger);
    const insert = (id: string, state: string) =>
      run(
        kit.env.DB,
        `INSERT INTO identity_certificates (id, identity_id, origin, state, created_at)
         VALUES (?, 'platform', 'env', ?, 1)`,
        [id, state],
      );
    await run(kit.env.DB, 'DELETE FROM identity_certificates');
    await insert('a', 'active');
    await insert('b', 'superseded');
    await expect(insert('c', 'active')).rejects.toThrow();
  });
});
