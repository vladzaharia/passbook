import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { grant } from '../../platform/authority.ts';
import { credentialAad, decryptSecretText, loadKekRing } from '../../platform/crypto.ts';
import { all, first } from '../../platform/db.ts';
import {
  listOrgCredentials,
  revokeOrgCredential,
  revokePlatformCredential,
  saveOrgCredential,
  savePlatformCredential,
} from './credential-service.ts';
import { type CredentialWriter, revokeCredential } from './repo-credentials.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
beforeAll(async () => {
  k = await kit();
}, 30_000);

const secrets = (k0: Kit) => [k0.privateKey, k0.google().serviceAccountEmail];

describe('org credentials', () => {
  it('creates and rotates in place with encrypted versions, events and audit, returning no secret', async () => {
    const org = await k.org();
    const { auth } = await k.member(org.id);
    const created = await saveOrgCredential(k.ctx, auth, org.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google(),
    });
    expect(created).toMatchObject({
      scope: 'org',
      orgId: org.id,
      mode: 'test',
      revision: 1,
      identityHint: '6789',
    });
    const rotated = await saveOrgCredential(k.ctx, auth, org.id, {
      provider: 'google',
      expectedRevision: 1,
      credentials: k.google(),
    });
    expect(rotated).toMatchObject({ id: created.id, revision: 2 });
    for (const text of secrets(k)) expect(JSON.stringify([created, rotated])).not.toContain(text);

    const versions = await all<{
      id: string;
      ciphertext: ArrayBuffer;
      iv: ArrayBuffer;
      wrapped_dek: ArrayBuffer;
      kek_version: number;
    }>(
      env.DB,
      'SELECT * FROM wallet_credential_versions WHERE credential_id = ? ORDER BY created_at, id',
      [created.id],
    );
    expect(versions).toHaveLength(2);
    expect(JSON.stringify(versions)).not.toContain(k.privateKey.slice(40, 80));
    const current = await first<{ current_version_id: string }>(
      env.DB,
      'SELECT current_version_id FROM wallet_credentials WHERE id = ?',
      [created.id],
    );
    const version = versions.find((v) => v.id === current?.current_version_id);
    if (!version) throw new Error('Missing current version');
    const text = await decryptSecretText(
      await loadKekRing(k.env),
      {
        kekVersion: version.kek_version,
        iv: new Uint8Array(version.iv),
        wrappedDek: new Uint8Array(version.wrapped_dek),
        ciphertext: new Uint8Array(version.ciphertext),
      },
      credentialAad(version.id, org.id, `wallet-credential:${created.id}:org:test:google`),
    );
    expect(JSON.parse(text)).toMatchObject({ version: 1, provider: 'google' });
    expect(
      (
        await all<{ revision: number; kind: string }>(
          env.DB,
          'SELECT revision, kind FROM wallet_credential_events WHERE credential_id = ? ORDER BY revision',
          [created.id],
        )
      ).map((e) => `${e.revision}:${e.kind}`),
    ).toEqual(['1:create', '2:rotate']);
    expect(
      (
        await all<{ action: string }>(
          env.DB,
          'SELECT action FROM audit_log WHERE target_id = ? ORDER BY id',
          [created.id],
        )
      ).map((r) => r.action),
    ).toEqual(['wallet_provider.credential_create', 'wallet_provider.credential_rotate']);
    expect((await listOrgCredentials(k.ctx, auth, org.id)).items.map((c) => c.id)).toEqual([
      created.id,
    ]);
  });

  it('refuses a stale revision, an identity change and a member without integrations:manage', async () => {
    const org = await k.org();
    const { auth } = await k.member(org.id);
    await saveOrgCredential(k.ctx, auth, org.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google(),
    });
    await expect(
      saveOrgCredential(k.ctx, auth, org.id, {
        provider: 'google',
        expectedRevision: 0,
        credentials: k.google(),
      }),
    ).rejects.toMatchObject({ code: 'WALLET_ACCOUNT_CONFLICT' });
    await expect(
      saveOrgCredential(k.ctx, auth, org.id, {
        provider: 'google',
        expectedRevision: 1,
        credentials: k.google('987654321'),
      }),
    ).rejects.toMatchObject({ code: 'WALLET_IDENTITY_IMMUTABLE' });
    const viewer = await k.member(org.id, 'test', ['template_author']);
    await expect(
      saveOrgCredential(k.ctx, viewer.auth, org.id, {
        provider: 'google',
        expectedRevision: 1,
        credentials: k.google(),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('keeps a Samsung card id across a rotation and refuses a changed one', async () => {
    const org = await k.org();
    const { auth } = await k.member(org.id);
    await saveOrgCredential(k.ctx, auth, org.id, {
      provider: 'samsung',
      expectedRevision: 0,
      credentials: k.samsung(),
    });
    await saveOrgCredential(k.ctx, auth, org.id, {
      provider: 'samsung',
      expectedRevision: 1,
      credentials: k.samsung(),
    });
    await expect(
      saveOrgCredential(k.ctx, auth, org.id, {
        provider: 'samsung',
        expectedRevision: 2,
        credentials: k.samsung('other-card'),
      }),
    ).rejects.toMatchObject({ code: 'WALLET_IDENTITY_IMMUTABLE' });
  });

  it('an org takes no identity the platform holds', async () => {
    const admin = await k.admin();
    const org = await k.org();
    const { auth } = await k.member(org.id);
    await savePlatformCredential(k.ctx, admin.auth, {
      mode: 'test',
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('555000111'),
    });
    await expect(
      saveOrgCredential(k.ctx, auth, org.id, {
        provider: 'google',
        expectedRevision: 0,
        credentials: k.google('555000111'),
      }),
    ).rejects.toMatchObject({ code: 'WALLET_IDENTITY_TAKEN' });
  });
});

describe('platform credentials', () => {
  it('only a platform admin writes them, and an org cannot revoke or write the row', async () => {
    const admin = await k.admin();
    const org = await k.org();
    const { auth } = await k.member(org.id);
    await expect(
      savePlatformCredential(k.ctx, auth, {
        mode: 'test',
        provider: 'samsung',
        expectedRevision: 0,
        credentials: k.samsung(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    const platform = await savePlatformCredential(k.ctx, admin.auth, {
      mode: 'test',
      provider: 'samsung',
      expectedRevision: 0,
      credentials: k.samsung(),
    });
    expect(platform).toMatchObject({ scope: 'platform', orgId: null, revision: 1 });
    // By id through the org route: it is not the org's row.
    await expect(
      revokeOrgCredential(k.ctx, auth, org.id, platform.id, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    // A hand-built org writer on the platform id: the grant refuses it too.
    const orgWriter: CredentialWriter = {
      purpose: 'org_mode.wallet.credential_revoke',
      principal: {
        kind: 'membership',
        membershipId:
          (
            await first<{ id: string }>(
              env.DB,
              'SELECT id FROM org_memberships WHERE org_id = ? AND user_id = ?',
              [org.id, auth.userId],
            )
          )?.id ?? '',
        via: 'session',
        sessionIdHash: auth.sessionId,
        mode: 'test',
      },
      checks: [],
      actor: { type: 'user', id: auth.userId },
      platform: false,
    };
    await expect(
      revokeCredential(k.ctx, orgWriter, {
        credentialId: platform.id,
        expectedRevision: 1,
        eventId: k.ctx.ids.id(),
      }),
    ).rejects.toMatchObject({ code: 'WALLET_ACCOUNT_CONFLICT' });
    expect(
      await first(
        env.DB,
        'SELECT revoked_at FROM wallet_credentials WHERE id = ? AND revoked_at IS NULL',
        [platform.id],
      ),
    ).not.toBeNull();
    await expect(
      revokePlatformCredential(k.ctx, auth, platform.id, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 403 });
    const revoked = await revokePlatformCredential(k.ctx, admin.auth, platform.id, {
      expectedRevision: 1,
    });
    expect(revoked.revokedAt).not.toBeNull();
  });

  it('an org grant cannot insert a credential check', async () => {
    const org = await k.org();
    const { auth } = await k.member(org.id);
    const g = grant(k.ctx, {
      purpose: 'org_mode.wallet.credential_save',
      principal: {
        kind: 'membership',
        membershipId: '-',
        via: 'session',
        sessionIdHash: auth.sessionId,
        mode: 'test',
      },
      tables: ['wallet_credentials', 'wallet_credential_checks'],
    });
    expect(() =>
      g.insertJoined('wallet_credential_checks', {
        parents: { credential_id: 'c' },
        columns: ['id', 'version_id', 'ok'],
        values: ['x', 'v', 1],
      }),
    ).toThrow(/credential_check/);
  });
});
