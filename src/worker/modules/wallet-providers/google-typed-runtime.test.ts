// CW9b end to end: a schema 2 Google release, the first tap, the typed class and object on the mock
// wallet server, revoke with its read back, and retirement. No real Google: fetch goes to the mock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { createMockWallets } from '../../../../test/mock-wallets/index.ts';
import type { CompileResult } from '../../../passkit/wallets/types.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { deletePass, updatePass } from '../passes/service.ts';
import { getVersion } from '../templates/repo.ts';
import { getWalletInstance, getWalletOperation } from './instance.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { computeProjectionPins } from './projection-pins.ts';
import {
  approveProjectionCandidate,
  createProjectionCandidate,
  publishProjectionRelease,
} from './projection-service.ts';
import { updateCompiler } from './projection-v2-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { drainWalletProviderSync } from './sync.ts';

const testEnv = installKeysetTestEnv();
let restore: (() => void)[] = [];
let mock = createMockWallets();
afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
  vi.unstubAllGlobals();
});

const text = (value: string) => ({ defaultValue: { language: 'en', value } });
const logo = {
  sourceUri: { uri: 'https://example.test/w/i/logo.png' },
  contentDescription: text('Logo'),
};
const barcode = { type: 'QR_CODE', renderEncoding: 'UTF_8', value: 'PSAMPLE' } as const;

/** Google, as the mock: provider hosts map onto it, nothing else leaves the test. */
function routeFetchToMock(): void {
  mock = createMockWallets();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const target =
      url.hostname === 'oauth2.googleapis.com'
        ? 'http://mock.test/token'
        : url.pathname.startsWith('/gp/v/save/')
          ? `http://mock.test${url.pathname}`
          : url.hostname === 'walletobjects.googleapis.com'
            ? `http://mock.test${url.pathname}`
            : null;
    if (!target) throw new Error(`Unexpected request to ${url.hostname}`);
    const { redirect: _r, signal: _s, ...rest } = init ?? {};
    return mock.handle(new Request(target, rest));
  });
}

/** A pass with a published schema 2 Google release; `compile` stands in for a template of another type. */
async function fixture(compile?: Parameters<typeof updateCompiler>[0]) {
  if (compile) restore.push(updateCompiler(compile, 0));
  routeFetchToMock();
  const f = await setupWalletOfferKit({
    google: 'configured',
    samsung: 'absent',
    db: (await testEnv()).DB,
  });
  const { kit, apple } = f;
  const version = await getVersion(kit.env.DB, kit.template.id, kit.template.version);
  if (!version) throw new Error('Offer fixture version is missing.');
  const { pins } = await computeProjectionPins(kit.ctx, 'google', version);
  const scope = { orgId: kit.org.id, mode: 'live' as const, provider: 'google' as const };
  const candidate = await createProjectionCandidate(kit.ctx, apple.authorAuth, kit.template.id, {
    ...scope,
    version: kit.template.version,
    sourceReleaseId: apple.id,
    projection: { schema: 2, provider: 'google', approvedOmissions: pins.approvedOmissions },
  });
  const approval = await approveProjectionCandidate(
    kit.ctx,
    apple.reviewerAuth,
    kit.template.id,
    candidate.id,
    { ...scope, candidateHash: candidate.candidateHash },
  );
  await publishProjectionRelease(kit.ctx, apple.publisherAuth, kit.template.id, {
    ...scope,
    candidateId: candidate.id,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    expectedGeneration: 0,
  });
  restore.push(setWalletProvidersEnabledForTest(true));
  // The database refuses a new provider instance and every offer (0043, 0114) until issuance is lifted
  // per account (Q2). This file's own database opens the four triggers that say so, and nothing else.
  for (const name of [
    'wallet_provider_generation_insert_guard',
    'wallet_provider_generation_binding_guard',
    'wallet_provider_generation_offer_insert',
    'wallet_provider_generation_offer_consume',
  ])
    await run(kit.env.DB, `DROP TRIGGER IF EXISTS ${name}`);
  return { f, pins };
}

const loyalty = (result: CompileResult): CompileResult => ({
  ...result,
  type: 'loyalty',
  classBody: {
    multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
    issuerName: 'Club',
    reviewStatus: 'UNDER_REVIEW',
    programName: 'Club',
    programLogo: logo,
  },
  objectBody: { state: 'ACTIVE', accountId: 'M1', barcode },
});

/** The capability token of the pass, as a holder's link carries it. */
async function tokenOf(f: Awaited<ReturnType<typeof fixture>>['f']): Promise<string> {
  const [offer] = await listWalletOffers(f.kit.ctx, f.pass.id);
  const token = offer?.href.split('/')[2];
  if (!token) throw new Error('The released Google design offered no link.');
  return token;
}

const savedObjectIds = async (location: string) => {
  const opened = await fetch(location);
  expect(opened.status).toBe(200);
  return mock.saves.at(-1)?.objectIds;
};

describe('the first tap', () => {
  it('builds the Generic class and object itself, then hands over the save link', async () => {
    const { f } = await fixture();
    const token = await tokenOf(f);
    const location = await issueWalletOffer(f.kit.ctx, token, 'google');
    expect(location).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect(mock.google.genericClass.size).toBe(1);
    const [object] = [...mock.google.genericObject.values()];
    expect(object).toMatchObject({
      state: 'ACTIVE',
      classId: [...mock.google.genericClass.keys()][0],
    });
    expect(await savedObjectIds(location)).toEqual([object?.id]);
    const instance = await getWalletInstance(f.kit.env.DB, {
      orgId: f.pass.orgId,
      mode: f.pass.mode,
      provider: 'google',
      passId: f.pass.id,
    });
    expect(instance?.lifecycle).toBe('active');
    expect(
      await getWalletOperation(f.kit.env.DB, {
        orgId: f.pass.orgId,
        mode: f.pass.mode,
        provider: 'google',
        instanceId: instance?.id ?? '',
        version: instance?.desiredVersion ?? 0,
      }),
    ).toMatchObject({ kind: 'upsert', state: 'succeeded' });
  });

  it('is repeatable: a second tap makes no second object and sends no second class', async () => {
    const { f } = await fixture();
    const token = await tokenOf(f);
    await issueWalletOffer(f.kit.ctx, token, 'google');
    const sent = mock.requests.length;
    const again = await issueWalletOffer(f.kit.ctx, token, 'google');
    expect(again).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect(mock.google.genericObject.size).toBe(1);
    expect(mock.requests.slice(sent).filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('never answers 404 when the provider is slow to take the object: a retryable error, then success', async () => {
    const { f } = await fixture();
    const token = await tokenOf(f);
    mock.failNext({
      status: 429,
      match: 'POST /walletobjects/v1/genericClass',
      retryAfterSeconds: 1,
    });
    await expect(issueWalletOffer(f.kit.ctx, token, 'google')).rejects.toMatchObject({
      code: 'WALLET_PREPARING',
    });
    expect(mock.google.genericObject.size).toBe(0);
    f.kit.clock.advance(120_000);
    const location = await issueWalletOffer(f.kit.ctx, token, 'google');
    expect(location).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect(mock.google.genericObject.size).toBe(1);
  });
});

describe('typed classes and objects from the compiler', () => {
  it('sends a Loyalty pass to the loyalty collections, under review, with its own save payload', async () => {
    const { f } = await fixture(loyalty);
    const token = await tokenOf(f);
    const location = await issueWalletOffer(f.kit.ctx, token, 'google');
    const [cls] = [...mock.google.loyaltyClass.values()];
    expect(cls).toMatchObject({ programName: 'Club', reviewStatus: 'UNDER_REVIEW' });
    // The callback options ride on every class, whatever its type.
    expect(cls?.callbackOptions).toBeDefined();
    const [object] = [...mock.google.loyaltyObject.values()];
    expect(object).toMatchObject({ accountId: 'M1', state: 'ACTIVE', classId: cls?.id });
    expect(mock.google.genericObject.size).toBe(0);
    expect(await savedObjectIds(location)).toEqual([object?.id]);
  });

  it('refuses a pass that no longer compiles to the approved type, and sends nothing', async () => {
    const { f } = await fixture();
    const token = await tokenOf(f);
    // A later compiler change makes the same pass an Offer: the approval was for Generic.
    restore.push(updateCompiler((r) => ({ ...r, type: 'offer' }), 0));
    await expect(issueWalletOffer(f.kit.ctx, token, 'google')).rejects.toMatchObject({
      code: 'WALLET_PREPARING',
    });
    expect(mock.google.genericObject.size + mock.google.offerObject.size).toBe(0);
  });

  it('refuses a blocked pass without calling Google', async () => {
    const { f } = await fixture();
    const token = await tokenOf(f);
    restore.push(
      updateCompiler(
        (r) => ({ ...r, blocked: { code: 'IDENTITY_TOO_LONG', message: 'Too long.' } }),
        0,
      ),
    );
    await expect(issueWalletOffer(f.kit.ctx, token, 'google')).rejects.toMatchObject({
      code: 'WALLET_PREPARING',
    });
    expect(mock.requests.filter((r) => r.path.includes('walletobjects'))).toEqual([]);
  });
});

describe('a pass edit', () => {
  it('PATCHes the one object and does not send the unchanged class again', async () => {
    const { f } = await fixture();
    const token = await tokenOf(f);
    await issueWalletOffer(f.kit.ctx, token, 'google');
    const jobCtx = jobCtxOf(f.kit);
    const mark = mock.requests.length;
    await updatePass(
      jobCtx,
      { type: 'system', id: null },
      f.pass.id,
      { input: { memberName: 'Updated Member' } },
      { scope: null },
    );
    await drainWalletProviderSync(jobCtx);
    const sent = mock.requests.slice(mark).filter((r) => r.path.includes('walletobjects'));
    expect(sent.map((r) => `${r.method} ${r.path.split('/')[3]}`)).toEqual(['PATCH genericObject']);
    const [object] = [...mock.google.genericObject.values()];
    expect(JSON.stringify(object)).toContain('Updated Member');
    expect(mock.google.genericObject.size).toBe(1);
  });
});

describe('revoke and retirement', () => {
  it.each([
    ['generic', undefined, 'genericObject'],
    ['loyalty', loyalty, 'loyaltyObject'],
  ] as const)(
    '%s: a deleted pass is PUT inactive, read back, then retired and settled',
    async (_type, compile, collection) => {
      const { f } = await fixture(compile);
      const token = await tokenOf(f);
      await issueWalletOffer(f.kit.ctx, token, 'google');
      const jobCtx = jobCtxOf(f.kit);
      await deletePass(jobCtx, { type: 'system', id: null }, f.pass.id, null);
      const mark = mock.requests.length;
      await drainWalletProviderSync(jobCtx);
      const [object] = [...mock.google[collection].values()];
      expect(object).toMatchObject({
        state: 'INACTIVE',
        messages: [{ body: 'This pass is no longer valid.' }],
      });
      expect(object).not.toHaveProperty('barcode');
      expect(mock.requests.slice(mark).map((r) => r.method)).toEqual(['GET', 'PUT', 'GET']);
      expect(
        await all(f.kit.env.DB, 'SELECT version FROM wallet_google_revocation_confirmations'),
      ).toHaveLength(1);
      // The drain's retirement step runs after the operations: one more pass settles it.
      await drainWalletProviderSync(jobCtx);
      expect(
        await first(
          f.kit.env.DB,
          "SELECT lifecycle, retirement_settled_at FROM wallet_provider_instances WHERE provider = 'google' AND pass_id = ? AND lifecycle = 'retired'",
          [f.pass.id],
        ),
      ).toMatchObject({ lifecycle: 'retired', retirement_settled_at: expect.any(Number) });
    },
  );

  it('does not settle when Google gives the object back still active', async () => {
    const { f } = await fixture();
    const token = await tokenOf(f);
    await issueWalletOffer(f.kit.ctx, token, 'google');
    const jobCtx = jobCtxOf(f.kit);
    await deletePass(jobCtx, { type: 'system', id: null }, f.pass.id, null);
    // Acknowledge the PUT but keep serving the old object: the revoke is not confirmed.
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        await real(input, init);
        const [held] = [...mock.google.genericObject.values()];
        Object.assign(held ?? {}, { state: 'ACTIVE', barcode });
        return Response.json(held);
      }
      return real(input, init);
    });
    await drainWalletProviderSync(jobCtx);
    expect(await all(f.kit.env.DB, 'SELECT 1 FROM wallet_google_revocation_confirmations')).toEqual(
      [],
    );
    await drainWalletProviderSync(jobCtx);
    expect(
      await first(
        f.kit.env.DB,
        "SELECT 1 FROM wallet_provider_instances WHERE provider = 'google' AND pass_id = ? AND retirement_settled_at IS NOT NULL",
        [f.pass.id],
      ),
    ).toBeNull();
  });
});
