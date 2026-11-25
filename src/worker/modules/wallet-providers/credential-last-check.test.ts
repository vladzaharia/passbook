import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockWallets } from '../../../../test/mock-wallets/index.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { runCredentialCheck } from './account-check.ts';
import {
  listOrgCredentials,
  listPlatformCredentials,
  revokePlatformCredential,
  saveOrgCredential,
  savePlatformCredential,
} from './credential-service.ts';
import { lastChecksOf } from './repo-credential-checks.ts';
import { findActiveCredential } from './repo-credentials.ts';
import { uid } from './repo-wallet-credentials-test-fixtures.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
let mock: ReturnType<typeof createMockWallets>;
beforeAll(async () => {
  k = await kit();
}, 30_000);

function stubProviders() {
  mock = createMockWallets();
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    mock.handle(new Request(input, init)),
  );
}
afterEach(() => vi.unstubAllGlobals());

async function platformSave(revision: number) {
  const admin = await k.admin();
  const saved = await savePlatformCredential(k.ctx, admin.auth, {
    provider: 'google',
    mode: 'live',
    expectedRevision: revision,
    credentials: k.google(),
  } as never);
  return { admin, saved };
}

const check = (credentialId: string) =>
  runCredentialCheck(createJobContext(k.env, 'wallet.credential_check'), {
    credentialId,
    checkId: uid(),
  });

async function lastCheckOf(admin: Awaited<ReturnType<Kit['admin']>>, id: string) {
  const list = await listPlatformCredentials(k.ctx, admin.auth);
  return list.items.find((c) => c.id === id)?.lastCheck;
}

describe('credential lastCheck', () => {
  it('shows the latest check of the current version, passed or failed, for a platform credential', async () => {
    stubProviders();
    const admin = await k.admin();
    const active = await findActiveCredential(env.DB, null, 'live', 'google');
    if (active)
      await revokePlatformCredential(k.ctx, admin.auth, active.id, {
        expectedRevision: active.revision,
      });
    const { saved } = await platformSave(0);
    expect(await lastCheckOf(admin, saved.id)).toBeNull();

    await check(saved.id);
    expect(await lastCheckOf(admin, saved.id)).toMatchObject({ ok: true, code: null });
    // verified_at keeps its meaning: a platform credential is never marked verified.
    const listed = (await listPlatformCredentials(k.ctx, admin.auth)).items.find(
      (c) => c.id === saved.id,
    );
    expect(listed?.verifiedAt).toBeNull();

    mock.failNext({ status: 401, match: 'POST /token' });
    await check(saved.id);
    expect(await lastCheckOf(admin, saved.id)).toMatchObject({ ok: false, code: 'auth_failed' });

    await check(saved.id);
    expect(await lastCheckOf(admin, saved.id)).toMatchObject({ ok: true, code: null });
  });

  it('does not count a check of an older version', async () => {
    stubProviders();
    const admin = await k.admin();
    const active = await findActiveCredential(env.DB, null, 'live', 'google');
    if (active)
      await revokePlatformCredential(k.ctx, admin.auth, active.id, {
        expectedRevision: active.revision,
      });
    const { saved } = await platformSave(0);
    await check(saved.id);
    expect(await lastCheckOf(admin, saved.id)).toMatchObject({ ok: true });
    await platformSave(saved.revision);
    expect(await lastCheckOf(admin, saved.id)).toBeNull();
  });

  it('lists an org credential with its check, and null for a check of an earlier version', async () => {
    stubProviders();
    const org = await k.org();
    const { auth } = await k.member(org.id);
    const created = await saveOrgCredential(k.ctx, auth, org.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google(),
    });
    expect(created.lastCheck).toBeNull();
    await check(created.id);
    const [listed] = (await listOrgCredentials(k.ctx, auth, org.id)).items;
    expect(listed?.lastCheck).toMatchObject({ ok: true, code: null });
    const rotated = await saveOrgCredential(k.ctx, auth, org.id, {
      provider: 'google',
      expectedRevision: listed?.revision ?? 0,
      credentials: k.google(),
    });
    expect(rotated.lastCheck).toBeNull();
    expect((await listOrgCredentials(k.ctx, auth, org.id)).items[0]?.lastCheck).toBeNull();
  });

  it("does not read another scope's check", async () => {
    stubProviders();
    const admin = await k.admin();
    const active = await findActiveCredential(env.DB, null, 'live', 'google');
    if (active)
      await revokePlatformCredential(k.ctx, admin.auth, active.id, {
        expectedRevision: active.revision,
      });
    const { saved } = await platformSave(0);
    await check(saved.id);
    expect(await lastChecksOf(env.DB, 'some-org', [saved.id])).toEqual([]);
    expect(await lastChecksOf(env.DB, null, [saved.id])).toHaveLength(1);
  });
});
