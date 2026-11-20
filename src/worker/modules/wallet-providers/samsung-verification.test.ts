import { compactVerify, importX509 } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { fakeAuth, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { SamsungWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import { createApp } from '../../app.ts';
import { all, batch, first, run, stmt } from '../../platform/db.ts';
import { createJobContext, createServiceContext } from '../../platform/service-context.ts';
import { createSession, createSessionStore, resolveSession } from '../auth/sessions.ts';
import { approveAppleRelease, grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import {
  credentialRefKeysetCommitment,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { configureWalletProviderAccount, revokeWalletProviderAccount } from './account-service.ts';
import { replaceCallbackKeysetForTest } from './callbacks-test-fixtures.ts';
import { makeProviderTestTemplate } from './offers-test-fixtures.ts';
import { approveProjectionCandidate, createProjectionCandidate } from './projection-service.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { getProjectionCandidate } from './repo-projection-store.ts';
import {
  beginSamsungProjectionProbe,
  completeSamsungProjectionProbe,
  failSamsungProjectionProbe,
  hasSamsungProjectionEvidence,
} from './repo-samsung-verification.ts';
import {
  ensureSamsungProjectionEvidence,
  refreshSamsungProjectionEvidence,
  reprobeSamsungProjectionEvidence,
} from './samsung-verification.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

const origin = 'https://wallet.test';
const endpoint = 'https://tsapi-card.walletsvc.samsung.com/partner/v1/card/template/card123';
const samsungTemplate = {
  cardId: 'card123',
  cardType: 'loyalty',
  subType: 'others',
  countryCode: 'GB',
  state: 'ACTIVE',
  testingModeOff: 'Y',
};
const projection = {
  schema: 1,
  provider: 'samsung',
  language: 'en',
  logoUrl: 'https://example.test/logo.png',
  sourceArtworkSlots: ['icon'],
  titleField: 'name',
  fields: ['name'],
  barcode: 'none',
  cardType: 'loyalty',
  cardSubType: 'others',
  countryCode: 'GB',
  appLinkLogo: 'https://example.test/app.png',
  appLinkName: 'Account',
  appLinkData: 'https://example.test/account',
} as const;

async function fixture(mode: Mode = 'live') {
  const kit = await setupKit({ template: makeProviderTestTemplate });
  kit.env.KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  kit.env.PUBLIC_BASE_URL = origin;
  const apple = await approveAppleRelease(kit, { mode });
  const user = await makeUser(kit.fx);
  await grantKitMembership(kit, kit.org.id, user.id, ['org_admin']);
  const session = await createSession(kit.ctx, {
    userId: user.id,
    roles: ['user'],
    amr: 'oidc',
    ipPrefix: null,
    userAgent: null,
  });
  const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
  if (!resolved) throw new Error('Missing session.');
  const auth = { ...resolved, mode };
  const identity = await createFixtureIdentity(undefined, { now: new Date(kit.clock.now()) });
  const credentials: SamsungWalletCredentials = {
    partnerId: 'partner123',
    certificateId: 'AB12',
    cardId: 'card123',
    partnerPrivateKeyPem: identity.privateKey,
    partnerCertificatePem: identity.certificate,
    samsungCertificatePem: identity.certificate,
  };
  const scope = { orgId: kit.org.id, mode, provider: 'samsung' as const };
  const configured = await configureWalletProviderAccount(kit.ctx, auth, {
    ...scope,
    expectedRevision: 0,
    credentials,
  });
  const proof = {
    credentialKeysetCommitment: await requireCredentialRefKeyset(kit.env.DB, kit.env),
  };
  const candidate = await createProjectionCandidate(kit.ctx, apple.authorAuth, kit.template.id, {
    ...scope,
    version: kit.template.version,
    sourceReleaseId: apple.id,
    projection,
  });
  const input = {
    orgId: scope.orgId,
    mode,
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
  };
  async function approve() {
    return approveProjectionCandidate(kit.ctx, apple.reviewerAuth, kit.template.id, candidate.id, {
      ...scope,
      candidateHash: candidate.candidateHash,
    });
  }
  const stored = async () => {
    const value = await getProjectionCandidate(kit.env.DB, candidate.id);
    if (!value) throw new Error('Missing candidate.');
    return value;
  };
  return {
    // An expired proof is refreshed by an admin or a job, which is a job context here.
    kit: { ...kit, ctx: createJobContext(kit.env, 'test', { clock: kit.clock }) },
    apple,
    auth,
    session,
    identity,
    credentials,
    scope,
    configured,
    candidate,
    input,
    approve,
    stored,
    proof,
  };
}

function success(): Response {
  return Response.json({
    resultCode: '0',
    resultMessage: 'SUCCESS',
    template: { ...samsungTemplate, title: 'provider-private-label' },
  });
}

function respond(response: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response()),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('authenticated Samsung card-state evidence', () => {
  it('requires separate human review, signs the real fixed-host GET and stores only bounded proof', async () => {
    const f = await fixture();
    respond(success);
    expect(await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).toEqual({
      verified: false,
      verifiedAt: null,
      expiresAt: null,
    });
    expect(fetch).not.toHaveBeenCalled();
    await f.approve();
    const key = await importX509(f.identity.certificate, 'RS256');
    let checked = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(endpoint);
        expect(init?.method).toBe('GET');
        expect(init?.redirect).toBe('manual');
        expect(init?.signal).toBeDefined();
        const headers = new Headers(init?.headers);
        expect(headers.get('x-smcs-partner-id')).toBe(f.credentials.partnerId);
        expect(headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/);
        const authorization = headers.get('authorization');
        expect(authorization).toMatch(/^Bearer /);
        const signed = await compactVerify(authorization!.slice(7), key, { algorithms: ['RS256'] });
        expect(signed.protectedHeader).toMatchObject({
          alg: 'RS256',
          cty: 'AUTH',
          ver: '3',
          partnerId: f.credentials.partnerId,
          certificateId: f.credentials.certificateId,
          utc: f.kit.clock.now(),
        });
        expect(JSON.parse(new TextDecoder().decode(signed.payload))).toEqual({
          API: { method: 'GET', path: '/partner/v1/card/template/card123' },
        });
        checked = true;
        return success();
      }),
    );
    const now = f.kit.clock.now();
    expect(await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).toEqual({
      verified: true,
      verifiedAt: now,
      expiresAt: now + 300_000,
    });
    expect(checked).toBe(true);
    const c = await f.stored();
    expect(await hasSamsungProjectionEvidence(f.kit.ctx, c)).toBe(true);
    const current = await first<Record<string, unknown>>(
      f.kit.env.DB,
      'SELECT * FROM wallet_provider_projection_evidence WHERE candidate_id = ?',
      [c.id],
    );
    const history = await all<Record<string, unknown>>(
      f.kit.env.DB,
      'SELECT * FROM wallet_provider_projection_evidence_history WHERE candidate_id = ?',
      [c.id],
    );
    expect(current).toMatchObject({
      status: 'verified',
      candidate_hash: c.candidateHash,
      account_id: c.accountId,
      account_revision: c.accountRevision,
      provider_identity_hash: c.providerIdentityHash,
      card_type: 'loyalty',
      card_sub_type: 'others',
      country_code: 'GB',
      testing_mode_off: 'Y',
      credential_keyset_commitment: f.proof.credentialKeysetCommitment,
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      credential_keyset_commitment: f.proof.credentialKeysetCommitment,
    });
    const epoch = await first<{ e: number; c: number }>(
      f.kit.env.DB,
      `SELECT a.authority_epoch AS e, k.provider_account_epoch AS c FROM template_candidates k
       JOIN wallet_provider_accounts a ON a.id = k.provider_account_id WHERE k.id = ?`,
      [c.id],
    );
    expect(epoch?.e).toBeGreaterThan(0);
    expect(epoch?.c).toBe(epoch?.e);
    expect(current?.account_epoch).toBe(epoch?.e);
    expect(history[0]?.account_epoch).toBe(epoch?.e);
    for (const sql of [
      'UPDATE template_candidates SET provider_account_epoch = 99 WHERE id = ?',
      'UPDATE wallet_provider_projection_evidence_history SET account_epoch = 99 WHERE candidate_id = ?',
    ])
      await expect(run(f.kit.env.DB, sql, [c.id])).rejects.toThrow(/immutable/);
    expect(JSON.stringify({ current, history })).not.toContain(f.credentials.partnerPrivateKeyPem);
    expect(JSON.stringify({ current, history })).not.toContain('provider-private-label');
    await expect(
      run(
        f.kit.env.DB,
        'UPDATE wallet_provider_projection_evidence_history SET country_code = ? WHERE candidate_id = ?',
        ['US', c.id],
      ),
    ).rejects.toThrow(/immutable Samsung provider evidence/);
    await expect(
      run(
        f.kit.env.DB,
        'DELETE FROM wallet_provider_projection_evidence_history WHERE candidate_id = ?',
        [c.id],
      ),
    ).rejects.toThrow(/immutable Samsung provider evidence/);
    expect(await hasSamsungProjectionEvidence(f.kit.ctx, { ...c, orgId: 'another-org' })).toBe(
      false,
    );
    expect(await hasSamsungProjectionEvidence(f.kit.ctx, { ...c, mode: 'test' })).toBe(false);
    expect(
      await hasSamsungProjectionEvidence(f.kit.ctx, { ...c, accountId: 'another-account' }),
    ).toBe(false);
    expect(
      await hasSamsungProjectionEvidence(f.kit.ctx, {
        ...c,
        accountRevision: c.accountRevision + 1,
      }),
    ).toBe(false);
    expect(
      await hasSamsungProjectionEvidence(f.kit.ctx, { ...c, providerIdentityHash: 'a'.repeat(64) }),
    ).toBe(false);
    expect(
      await hasSamsungProjectionEvidence(f.kit.ctx, { ...c, candidateHash: 'b'.repeat(64) }),
    ).toBe(false);
    f.kit.clock.set(now - 1);
    expect(await hasSamsungProjectionEvidence(f.kit.ctx, c)).toBe(false);
    f.kit.clock.set(now + 299_999);
    expect(await hasSamsungProjectionEvidence(f.kit.ctx, c)).toBe(true);
    f.kit.clock.advance(1);
    expect(await hasSamsungProjectionEvidence(f.kit.ctx, c)).toBe(false);
  });

  it('invalidates earlier proof on every unavailable, rejected, ambiguous or mismatched provider result', async () => {
    const f = await fixture();
    await f.approve();
    const cases: (() => Response)[] = [
      () => new Response('private 401 body', { status: 401 }),
      () => new Response('private 403 body', { status: 403 }),
      () => new Response('private server body', { status: 503 }),
      () => new Response(null, { status: 302, headers: { location: 'https://attacker.test/' } }),
      () =>
        Response.json({ resultCode: '0', template: samsungTemplate, templates: samsungTemplate }),
      () => Response.json({ resultCode: '0', template: { ...samsungTemplate, cardId: 'other' } }),
      () =>
        Response.json({ resultCode: '0', template: { ...samsungTemplate, state: 'VERIFYING' } }),
      () =>
        Response.json({ resultCode: '0', template: { ...samsungTemplate, testingModeOff: 'N' } }),
      () =>
        Response.json({
          resultCode: '0',
          template: { ...samsungTemplate, testingModeOff: undefined },
        }),
      () =>
        Response.json({ resultCode: '0', template: { ...samsungTemplate, cardType: 'generic' } }),
      () => Response.json({ resultCode: '0', template: { ...samsungTemplate, subType: 'other' } }),
      () => Response.json({ resultCode: '0', template: { ...samsungTemplate, countryCode: 'US' } }),
      () => new Response('x'.repeat(65_537)),
      () => Response.json({ resultCode: '1', template: samsungTemplate }),
    ];
    for (const failed of cases) {
      respond(success);
      expect((await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).verified).toBe(
        true,
      );
      respond(failed);
      expect(await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).toEqual({
        verified: false,
        verifiedAt: null,
        expiresAt: null,
      });
      expect(await hasSamsungProjectionEvidence(f.kit.ctx, await f.stored())).toBe(false);
      const evidence = await first<{ status: string }>(
        f.kit.env.DB,
        'SELECT status FROM wallet_provider_projection_evidence WHERE candidate_id = ?',
        [f.candidate.id],
      );
      expect(evidence?.status).toBe('unverified');
    }
    respond(success);
    expect((await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).verified).toBe(
      true,
    );
    const warn = vi.spyOn(f.kit.ctx.log, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('private network failure');
      }),
    );
    expect((await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).verified).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledWith('wallet.verification_failed', {
      code: 'WALLET_VERIFY_FAILED',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private network failure');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(f.credentials.partnerPrivateKeyPem);
    warn.mockRestore();
    expect(await hasSamsungProjectionEvidence(f.kit.ctx, await f.stored())).toBe(false);
  });

  it('also requires ACTIVE and Y in test mode and enforces tenant and mode authority', async () => {
    const f = await fixture('test');
    await f.approve();
    respond(() =>
      Response.json({ resultCode: '0', template: { ...samsungTemplate, testingModeOff: 'N' } }),
    );
    expect((await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).verified).toBe(
      false,
    );
    respond(success);
    expect((await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).verified).toBe(
      true,
    );
    await expect(
      refreshSamsungProjectionEvidence(f.kit.ctx, { ...f.auth, mode: 'live' }, f.input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const foreign = await makeOrg(f.kit.fx);
    await expect(
      refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, { ...f.input, orgId: foreign.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, {
        ...f.input,
        candidateHash: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_NOT_FOUND' });
  });

  it('refreshes expired proof on demand and fails closed rather than reusing it', async () => {
    const f = await fixture();
    await f.approve();
    respond(success);
    expect(
      await ensureSamsungProjectionEvidence(f.kit.ctx, f.candidate.id, f.candidate.candidateHash),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      await ensureSamsungProjectionEvidence(f.kit.ctx, f.candidate.id, f.candidate.candidateHash),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    f.kit.clock.advance(300_000);
    respond(() => new Response(null, { status: 401 }));
    expect(
      await ensureSamsungProjectionEvidence(f.kit.ctx, f.candidate.id, f.candidate.candidateHash),
    ).toBe(false);
    expect(await hasSamsungProjectionEvidence(f.kit.ctx, await f.stored())).toBe(false);
    respond(success);
    expect(
      await ensureSamsungProjectionEvidence(f.kit.ctx, f.candidate.id, f.candidate.candidateHash),
    ).toBe(true);
    expect(await ensureSamsungProjectionEvidence(f.kit.ctx, f.candidate.id, 'a'.repeat(64))).toBe(
      false,
    );
  });

  it('keeps a request path on the cached proof and lets a job re-probe it before it lapses', async () => {
    const f = await fixture();
    await f.approve();
    const plain = createServiceContext(f.kit.env, { clock: f.kit.clock });
    respond(success);
    expect(
      await ensureSamsungProjectionEvidence(f.kit.ctx, f.candidate.id, f.candidate.candidateHash),
    ).toBe(true);
    f.kit.clock.advance(240_000);
    expect(
      await reprobeSamsungProjectionEvidence(f.kit.ctx, f.candidate.id, f.candidate.candidateHash),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    f.kit.clock.advance(100_000);
    expect(await hasSamsungProjectionEvidence(plain, await f.stored())).toBe(true);
    // Without the job the proof lapses, and a request path cannot write one: it fails closed.
    f.kit.clock.advance(300_000);
    expect(
      await ensureSamsungProjectionEvidence(plain, f.candidate.id, f.candidate.candidateHash),
    ).toBe(false);
    expect(await hasSamsungProjectionEvidence(plain, await f.stored())).toBe(false);
  });

  it('refuses to write evidence without an authority outside a job', async () => {
    const f = await fixture();
    await f.approve();
    const plain = createServiceContext(f.kit.env, { clock: f.kit.clock });
    expect(await beginSamsungProjectionProbe(plain, null, await f.stored(), plain.ids.id())).toBe(
      false,
    );
  });

  it('commits an in-flight response across a rotation under the same identity', async () => {
    const f = await fixture();
    await f.approve();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await configureWalletProviderAccount(f.kit.ctx, f.auth, {
          ...f.scope,
          expectedRevision: f.configured.revision,
          credentials: f.credentials,
        });
        return success();
      }),
    );
    expect((await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).verified).toBe(
      true,
    );
    expect(await hasSamsungProjectionEvidence(f.kit.ctx, await f.stored())).toBe(true);
  });

  it('cannot commit an in-flight response after a revoke or a newer failed probe', async () => {
    const f = await fixture();
    await f.approve();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await revokeWalletProviderAccount(f.kit.ctx, f.auth, {
          ...f.scope,
          expectedRevision: f.configured.revision,
        });
        return success();
      }),
    );
    expect((await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).verified).toBe(
      false,
    );
    expect(await hasSamsungProjectionEvidence(f.kit.ctx, await f.stored())).toBe(false);

    const other = await fixture();
    await other.approve();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<Response>();
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (++calls === 1) {
          entered.resolve();
          return finish.promise;
        }
        return new Response(null, { status: 403 });
      }),
    );
    const older = refreshSamsungProjectionEvidence(other.kit.ctx, other.auth, other.input);
    await entered.promise;
    expect(
      (await refreshSamsungProjectionEvidence(other.kit.ctx, other.auth, other.input)).verified,
    ).toBe(false);
    finish.resolve(success());
    expect((await older).verified).toBe(false);
    expect(await hasSamsungProjectionEvidence(other.kit.ctx, await other.stored())).toBe(false);
    expect(
      await all(
        other.kit.env.DB,
        'SELECT id FROM wallet_provider_projection_evidence_history WHERE candidate_id = ?',
        [other.candidate.id],
      ),
    ).toEqual([]);
  });

  it('does not commit after the admin session is revoked or the probe window has elapsed', async () => {
    const f = await fixture();
    await f.approve();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await run(f.kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
          f.kit.clock.now(),
          f.auth.sessionId,
        ]);
        return success();
      }),
    );
    expect((await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).verified).toBe(
      false,
    );
    expect(await hasSamsungProjectionEvidence(f.kit.ctx, await f.stored())).toBe(false);
    expect(
      await all(
        f.kit.env.DB,
        'SELECT id FROM wallet_provider_projection_evidence_history WHERE candidate_id = ?',
        [f.candidate.id],
      ),
    ).toEqual([]);

    const slow = await fixture();
    await slow.approve();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        slow.kit.clock.advance(300_000);
        return success();
      }),
    );
    expect(
      (await refreshSamsungProjectionEvidence(slow.kit.ctx, slow.auth, slow.input)).verified,
    ).toBe(false);
    expect(await hasSamsungProjectionEvidence(slow.kit.ctx, await slow.stored())).toBe(false);
  });

  it.each(['changed', 'missing'] as const)(
    'refuses a mismatched keyset pin at entry when the singleton is %s',
    async (change) => {
      const f = await fixture();
      await f.approve();
      respond(success);
      expect((await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).verified).toBe(
        true,
      );
      const candidate = await f.stored();
      const db = f.kit.env.DB;
      const replacement = await credentialRefKeysetCommitment({
        ...f.kit.env,
        KEK_V1: btoa('z'.repeat(32)),
      });
      expect(replacement).not.toBe(f.proof.credentialKeysetCommitment);
      const before = await first(
        db,
        'SELECT * FROM wallet_provider_projection_evidence WHERE candidate_id = ?',
        [candidate.id],
      );
      await replaceCallbackKeysetForTest(db, change === 'changed' ? replacement : null);
      try {
        await expect(
          ensureSamsungProjectionEvidence(f.kit.ctx, candidate.id, candidate.candidateHash),
        ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
        await expect(
          refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input),
        ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(
          await first(
            db,
            'SELECT * FROM wallet_provider_projection_evidence WHERE candidate_id = ?',
            [candidate.id],
          ),
        ).toEqual(before);
        if (change === 'missing')
          expect(
            await first(db, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
          ).toBeNull();
      } finally {
        await replaceCallbackKeysetForTest(db, f.proof.credentialKeysetCommitment);
      }
      expect(await hasSamsungProjectionEvidence(f.kit.ctx, candidate)).toBe(true);
    },
    120_000,
  );

  it('never adopts verified or pending evidence after a rekey, even when a new proof matches the new singleton', async () => {
    const f = await fixture();
    await f.approve();
    respond(success);
    expect((await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).verified).toBe(
      true,
    );
    const candidate = await f.stored();
    const db = f.kit.env.DB;
    const oldKey = f.kit.env.KEK_V1;
    const newKey = btoa('z'.repeat(32));
    const newProof = {
      credentialKeysetCommitment: await credentialRefKeysetCommitment({
        ...f.kit.env,
        KEK_V1: newKey,
      }),
    };
    const current = await first(
      db,
      'SELECT * FROM wallet_provider_projection_evidence WHERE candidate_id = ?',
      [candidate.id],
    );
    const history = await all(
      db,
      'SELECT * FROM wallet_provider_projection_evidence_history WHERE candidate_id = ?',
      [candidate.id],
    );
    const probeId = f.kit.ctx.ids.id();
    expect(newProof.credentialKeysetCommitment).not.toBe(f.proof.credentialKeysetCommitment);
    f.kit.env.KEK_V1 = newKey;
    await replaceCallbackKeysetForTest(db, newProof.credentialKeysetCommitment);
    try {
      expect(await hasSamsungProjectionEvidence(f.kit.ctx, candidate)).toBe(false);
      expect(
        await ensureSamsungProjectionEvidence(f.kit.ctx, candidate.id, candidate.candidateHash),
      ).toBe(false);
      // The candidate is stored under the old keyset, so it is not found after the rekey.
      await expect(
        refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input),
      ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_NOT_FOUND' });
      expect(await beginSamsungProjectionProbe(f.kit.ctx, null, candidate, probeId)).toBe(false);
      // A mismatched pin at entry refuses: the old KEK no longer matches the rekeyed singleton.
      f.kit.env.KEK_V1 = oldKey;
      await expect(
        ensureSamsungProjectionEvidence(f.kit.ctx, candidate.id, candidate.candidateHash),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
      f.kit.env.KEK_V1 = newKey;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(
        await first(
          db,
          'SELECT * FROM wallet_provider_projection_evidence WHERE candidate_id = ?',
          [candidate.id],
        ),
      ).toEqual(current);
      expect(
        await all(
          db,
          'SELECT * FROM wallet_provider_projection_evidence_history WHERE candidate_id = ?',
          [candidate.id],
        ),
      ).toEqual(history);
    } finally {
      f.kit.env.KEK_V1 = oldKey;
      await replaceCallbackKeysetForTest(db, f.proof.credentialKeysetCommitment);
    }
    expect(await beginSamsungProjectionProbe(f.kit.ctx, null, candidate, probeId)).toBe(true);
    const pending = await first(
      db,
      'SELECT * FROM wallet_provider_projection_evidence WHERE candidate_id = ?',
      [candidate.id],
    );
    expect(pending).toMatchObject({
      status: 'pending',
      probe_id: probeId,
      credential_keyset_commitment: f.proof.credentialKeysetCommitment,
    });
    f.kit.env.KEK_V1 = newKey;
    await replaceCallbackKeysetForTest(db, newProof.credentialKeysetCommitment);
    try {
      await failSamsungProjectionProbe(f.kit.ctx, null, candidate, probeId);
      expect(
        await completeSamsungProjectionProbe(
          f.kit.ctx,
          null,
          candidate,
          probeId,
          f.kit.clock.now(),
          f.kit.clock.now() + 300_000,
        ),
      ).toBe(false);
      expect(
        await beginSamsungProjectionProbe(f.kit.ctx, null, candidate, f.kit.ctx.ids.id()),
      ).toBe(false);
      expect(
        await first(
          db,
          'SELECT * FROM wallet_provider_projection_evidence WHERE candidate_id = ?',
          [candidate.id],
        ),
      ).toEqual(pending);
      expect(
        await all(
          db,
          'SELECT * FROM wallet_provider_projection_evidence_history WHERE candidate_id = ?',
          [candidate.id],
        ),
      ).toEqual(history);
    } finally {
      f.kit.env.KEK_V1 = oldKey;
      await replaceCallbackKeysetForTest(db, f.proof.credentialKeysetCommitment);
    }
    expect(
      await completeSamsungProjectionProbe(
        f.kit.ctx,
        null,
        candidate,
        probeId,
        f.kit.clock.now(),
        f.kit.clock.now() + 300_000,
      ),
    ).toBe(true);
    const finalHistory = await all<Record<string, unknown>>(
      db,
      'SELECT * FROM wallet_provider_projection_evidence_history WHERE candidate_id = ?',
      [candidate.id],
    );
    expect(finalHistory).toHaveLength(2);
    expect(
      finalHistory.every(
        (row) => row.credential_keyset_commitment === f.proof.credentialKeysetCommitment,
      ),
    ).toBe(true);
    expect(await hasSamsungProjectionEvidence(f.kit.ctx, candidate)).toBe(true);
  });

  it.each(['candidate', 'approval', 'current', 'history'] as const)(
    'does not reuse legacy %s provenance without a keyset commitment',
    async (legacy) => {
      const f = await fixture();
      await f.approve();
      respond(success);
      expect((await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).verified).toBe(
        true,
      );
      const candidate = await f.stored();
      const db = f.kit.env.DB;
      const triggerName = {
        candidate: 'template_candidates_immutable',
        approval: 'template_approvals_immutable',
        current: 'wallet_provider_evidence_keyset_update',
        history: 'wallet_provider_projection_evidence_history_no_update',
      }[legacy];
      const trigger = await first<{ sql: string }>(
        db,
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        [triggerName],
      );
      if (!trigger?.sql) throw new Error('Missing evidence immutability guard.');
      const table = {
        candidate: 'template_candidates',
        approval: 'template_approvals',
        current: 'wallet_provider_projection_evidence',
        history: 'wallet_provider_projection_evidence_history',
      }[legacy];
      const key = legacy === 'candidate' ? 'id' : 'candidate_id';
      // Model a pre-migration row while restoring the production trigger in the same transaction.
      await batch(db, [
        stmt(db, `DROP TRIGGER ${triggerName}`),
        stmt(db, `UPDATE ${table} SET credential_keyset_commitment = NULL WHERE ${key} = ?`, [
          f.candidate.id,
        ]),
        stmt(db, trigger.sql),
      ]);
      expect(await hasSamsungProjectionEvidence(f.kit.ctx, candidate)).toBe(false);
      if (legacy !== 'history') {
        expect(
          await beginSamsungProjectionProbe(f.kit.ctx, null, candidate, f.kit.ctx.ids.id()),
        ).toBe(false);
        expect(
          await ensureSamsungProjectionEvidence(
            f.kit.ctx,
            f.candidate.id,
            f.candidate.candidateHash,
          ),
        ).toBe(false);
        if (legacy === 'candidate') {
          await expect(
            refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input),
          ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_NOT_FOUND' });
        } else {
          expect(
            (await refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input)).verified,
          ).toBe(false);
        }
        expect(fetch).toHaveBeenCalledTimes(1);
      } else {
        const commitment = f.proof.credentialKeysetCommitment;
        expect(
          await first(
            db,
            'SELECT * FROM wallet_provider_projection_evidence WHERE candidate_id = ?',
            [candidate.id],
          ),
        ).toMatchObject({
          candidate_id: candidate.id,
          org_id: candidate.orgId,
          mode: candidate.mode,
          account_id: candidate.accountId,
          account_revision: candidate.accountRevision,
          provider_identity_hash: candidate.providerIdentityHash,
          candidate_hash: candidate.candidateHash,
          status: 'verified',
          credential_keyset_commitment: commitment,
        });
        // Check every source used to begin a fresh probe, independently of history.
        expect(
          await first(
            db,
            `SELECT 1 AS ok FROM template_candidates c
             JOIN orgs owner ON owner.id = c.org_id AND owner.status = 'active'
             JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
               AND account.org_id = c.org_id AND account.mode = c.mode AND account.provider = 'samsung'
               AND account.revision = c.provider_account_revision AND account.credential_id IS NOT NULL
               AND account.revoked_at IS NULL
             JOIN credential_ref_keyset keyset ON keyset.id = 1 AND keyset.commitment = c.credential_keyset_commitment
             JOIN template_approvals approval ON approval.candidate_id = c.id
               AND approval.candidate_hash = c.candidate_hash
               AND approval.credential_keyset_commitment = c.credential_keyset_commitment
               AND approval.reviewer_id != c.author_id
               AND (c.version_author_id IS NULL OR approval.reviewer_id != c.version_author_id)
             JOIN wallet_provider_projection_evidence ev ON ev.candidate_id = c.id
               AND ev.credential_keyset_commitment = c.credential_keyset_commitment
             WHERE c.id = ? AND c.provider = 'samsung' AND c.org_id = ? AND c.mode = ?
               AND c.candidate_hash = ? AND c.provider_account_id = ? AND c.provider_account_revision = ?
               AND c.provider_identity_hash = ? AND json_valid(c.projection_json)
               AND json_extract(c.projection_json, '$.cardType') = ?
               AND json_extract(c.projection_json, '$.cardSubType') = ?
               AND json_extract(c.projection_json, '$.countryCode') = ?
               AND c.credential_keyset_commitment = ?`,
            [
              candidate.id,
              candidate.orgId,
              candidate.mode,
              candidate.candidateHash,
              candidate.accountId,
              candidate.accountRevision,
              candidate.providerIdentityHash,
              projection.cardType,
              projection.cardSubType,
              projection.countryCode,
              commitment,
            ],
          ),
        ).toEqual({ ok: 1 });
        expect(
          await all(
            db,
            'SELECT credential_keyset_commitment FROM wallet_provider_projection_evidence_history WHERE candidate_id = ?',
            [candidate.id],
          ),
        ).toEqual([{ credential_keyset_commitment: null }]);
        // A fresh, independently authenticated provider response may replace a legacy history proof.
        const refreshed = await ensureSamsungProjectionEvidence(
          f.kit.ctx,
          f.candidate.id,
          f.candidate.candidateHash,
        );
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(refreshed).toBe(true);
        const history = await all<{ credential_keyset_commitment: string | null }>(
          db,
          'SELECT credential_keyset_commitment FROM wallet_provider_projection_evidence_history WHERE candidate_id = ?',
          [f.candidate.id],
        );
        expect(history).toHaveLength(2);
        expect(history.map((row) => row.credential_keyset_commitment)).toContain(null);
        expect(history.map((row) => row.credential_keyset_commitment)).toContain(
          f.proof.credentialKeysetCommitment,
        );
      }
    },
    120_000,
  );

  it('pins the original KEKs synchronously before either verification entry point awaits', async () => {
    const f = await fixture();
    await f.approve();
    respond(success);
    const oldKey = f.kit.env.KEK_V1;
    try {
      const refresh = refreshSamsungProjectionEvidence(f.kit.ctx, f.auth, f.input);
      f.kit.env.KEK_V1 = btoa('z'.repeat(32));
      expect((await refresh).verified).toBe(true);
      f.kit.env.KEK_V1 = oldKey;
      f.kit.clock.advance(300_000);
      const ensure = ensureSamsungProjectionEvidence(
        f.kit.ctx,
        f.candidate.id,
        f.candidate.candidateHash,
      );
      f.kit.env.KEK_V1 = btoa('z'.repeat(32));
      expect(await ensure).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      f.kit.env.KEK_V1 = oldKey;
    }
  });

  it('requires a CSRF-protected tenant session on the verification route', async () => {
    const f = await fixture();
    await f.approve();
    respond(success);
    const fake = fakeAuth(origin);
    const app = createApp({
      stores: { ...fake.stores, sessions: createSessionStore(f.kit.env, f.kit.clock) },
      clock: f.kit.clock,
    });
    const headers = {
      cookie: `__Host-wallet_sid=${f.session.cookieValue}`,
      'x-csrf-token': f.session.csrfSecret,
      'sec-fetch-site': 'same-origin',
      origin,
      'content-type': 'application/json',
    };
    const request = (given: Record<string, string>) =>
      app.request(
        `${origin}/api/v1/wallet-providers/accounts/verify`,
        {
          method: 'POST',
          headers: given,
          body: JSON.stringify(f.input),
        },
        f.kit.env,
      );
    expect((await request({ 'content-type': 'application/json' })).status).toBe(401);
    await expectProblem(await request({ ...headers, 'x-csrf-token': 'wrong' }), 403, 'CSRF_TOKEN');
    const response = await request(headers);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ verified: true });
  });
});
