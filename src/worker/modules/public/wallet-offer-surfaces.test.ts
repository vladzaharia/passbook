import type { OpenAPIHono } from '@hono/zod-openapi';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAuth, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { WalletOffer } from '../../../shared/contracts/me.ts';
import type { createApp as CreateApp } from '../../app.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import type { createSessionStore as CreateSessionStore } from '../auth/sessions.ts';
import type { jobCtxOf as JobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import type { getHolderPass as GetHolderPass } from '../holders/repo.ts';
import type { startCredentialTransfer as StartCredentialTransfer } from '../passes/credential-transfer.ts';
import type { Kit, setupKit as SetupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import type { getPass as GetPass } from '../passes/repo-read-pass.ts';
import type { listWalletOffers as ListWalletOffers } from '../wallet-providers/offers.ts';

// Stub only the eligibility result to exercise the surfaces once providers can genuinely offer.
vi.mock('../wallet-providers/offers.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWalletOffers: vi.fn(),
}));

const ORIGIN = 'https://wallet.test';
let lookup: ReturnType<typeof vi.mocked<typeof ListWalletOffers>>;
let startCredentialTransfer: typeof StartCredentialTransfer;
let getHolderPass: typeof GetHolderPass;
let getPass: typeof GetPass;
let kit: Kit;
// The job brand is a module singleton: it must come from the same fresh graph as the services.
let jobCtxOf: typeof JobCtxOf;
let app: OpenAPIHono<AppBindings>;
let holderEmail: string;
let otherUser: { id: string; primaryEmail: string };
let headers: Record<string, string>;
let restoreProviders: () => void;

beforeAll(async () => {
  // The setup file already loaded these modules; clearing the cache makes the mock effective, and
  // everything that shares dependency state must come from the same fresh graph.
  vi.resetModules();
  const { setupKit }: { setupKit: typeof SetupKit } = await import(
    '../passes/pass-test-fixtures.ts'
  );
  const { createApp }: { createApp: typeof CreateApp } = await import('../../app.ts');
  const { createSessionStore }: { createSessionStore: typeof CreateSessionStore } = await import(
    '../auth/sessions.ts'
  );
  ({ jobCtxOf } = await import('../delivery/delivery-test-fixtures.ts'));
  ({ getHolderPass } = await import('../holders/repo.ts'));
  ({ startCredentialTransfer } = await import('../passes/credential-transfer.ts'));
  ({ getPass } = await import('../passes/repo-read-pass.ts'));
  lookup = vi.mocked((await import('../wallet-providers/offers.ts')).listWalletOffers);
  // Providers are gated off in production; these surfaces are exercised as if they were released.
  const policy = await import('../wallet-providers/provider-policy.ts');
  restoreProviders = policy.setWalletProvidersEnabledForTest(true);
  kit = await setupKit();
  const holder = await makeUser(kit.fx);
  const other = await makeUser(kit.fx);
  holderEmail = holder.primaryEmail;
  otherUser = other;
  headers = (await makeSession(kit.fx, { userId: holder.id })).headers;
  app = createApp({
    stores: { ...fakeAuth(ORIGIN).stores, sessions: createSessionStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
});

afterAll(() => restoreProviders());

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue([]);
});

const get = (path: string, requestHeaders: Record<string, string> = {}) =>
  app.request(`${ORIGIN}${path}`, { headers: requestHeaders }, kit.env);
const pathFor = (pass: Pass, provider: 'google' | 'samsung') =>
  `/p/${pass.downloadToken}/wallet/${provider}`;

async function ownPass(mode: 'live' | 'test' = 'live') {
  return kit.pass({ mode, holderEmail });
}

async function transfer(pass: Pass) {
  const expected = await getHolderPass(kit.env.DB, pass.id, null);
  if (!expected) throw new Error('Missing holder transfer snapshot');
  const result = await startCredentialTransfer(
    jobCtxOf(kit),
    { type: 'system', id: null },
    pass.id,
    { holderEmail: otherUser.primaryEmail, ownerUserId: otherUser.id },
    null,
    { kind: 'tenant-holder', expected },
  );
  expect(result.state).toBe('completed');
  const fresh = await getPass(kit.env.DB, pass.id);
  if (!fresh) throw new Error('Missing completed pass');
  return fresh;
}

function offersFor(pass: Pass) {
  return [
    {
      provider: 'google' as const,
      href: pathFor(pass, 'google'),
      installation: 'unknown' as const,
      providerToken: 'private-google-token',
    },
    {
      provider: 'samsung' as const,
      href: pathFor(pass, 'samsung'),
      installation: 'unknown' as const,
      providerToken: 'private-samsung-token',
    },
    {
      provider: 'google' as const,
      href: '/p/another-bearer/wallet/google',
      installation: 'unknown' as const,
    },
  ];
}

function offerLookup(pass: Pass) {
  const offers = offersFor(pass);
  lookup.mockImplementation(async (_ctx, id) => (id === pass.id ? offers : []));
}

describe('native offers on public and holder surfaces', () => {
  it.each(['live', 'test'] as const)(
    'returns only same-bearer, secret-free capabilities for %s passes',
    async (mode) => {
      const pass = await ownPass(mode);
      offerLookup(pass);
      const htmlResponse = await get(`/p/${pass.downloadToken}`);
      expect(htmlResponse.status).toBe(200);
      const html = await htmlResponse.text();
      expect(html).toContain(`href="/p/${pass.downloadToken}/pass.pkpass"`);
      expect(html).toContain(`href="${pathFor(pass, 'google')}"`);
      expect(html).toContain(`href="${pathFor(pass, 'samsung')}"`);
      expect(html).not.toContain('/p/another-bearer/');
      expect(html).not.toContain('private-google-token');
      expect(html).not.toContain('private-samsung-token');

      const detailResponse = await get(`/api/v1/me/passes/${pass.id}`, headers);
      expect(detailResponse.status).toBe(200);
      const detailText = await detailResponse.text();
      const detail = JSON.parse(detailText) as { walletOffers: WalletOffer[]; inWallet: boolean };
      const expected = [
        { provider: 'google', href: pathFor(pass, 'google'), installation: 'unknown' },
        { provider: 'samsung', href: pathFor(pass, 'samsung'), installation: 'unknown' },
      ];
      expect(detail.walletOffers).toEqual(expected);
      expect(detail.inWallet).toBe(false);
      expect(detailText).not.toContain('private-google-token');
      expect(detailText).not.toContain('private-samsung-token');
      const listResponse = await get('/api/v1/me/passes', headers);
      expect(listResponse.status).toBe(200);
      const listText = await listResponse.text();
      const list = JSON.parse(listText) as { items: { id: string; walletOffers: WalletOffer[] }[] };
      expect(list.items.find((item) => item.id === pass.id)?.walletOffers).toEqual(expected);
      expect(listText).not.toContain('private-google-token');
      expect(listText).not.toContain('private-samsung-token');
    },
    120_000,
  );

  it.each(['list', 'detail'] as const)(
    'does not expose a new incarnation to a prior owner during %s lookup',
    async (surface) => {
      const pass = await ownPass();
      lookup.mockImplementation(async (_ctx, id) => {
        if (id !== pass.id) return [];
        await transfer(pass);
        return offersFor(pass);
      });
      const path = surface === 'list' ? '/api/v1/me/passes' : `/api/v1/me/passes/${pass.id}`;
      const response = await get(path, headers);
      expect(response.status).toBe(surface === 'list' ? 200 : 404);
      expect(lookup).toHaveBeenCalledWith(expect.anything(), pass.id);
      const text = await response.text();
      if (surface === 'list') {
        const body = JSON.parse(text) as { items: { id: string }[] };
        expect(body.items.some((item) => item.id === pass.id)).toBe(false);
      }
      expect(text).not.toContain(pass.downloadToken);
      expect(text).not.toContain('private-google-token');
      expect(text).not.toContain('private-samsung-token');
    },
    120_000,
  );

  it.each(['generation', 'revision', 'voided', 'removed', 'expired-json'] as const)(
    'drops holder capabilities when %s changes during lookup',
    async (change) => {
      const pass = await ownPass();
      lookup.mockImplementation(async (_ctx, id) => {
        if (id !== pass.id) return [];
        if (change === 'generation') {
          await run(
            kit.env.DB,
            'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?',
            [pass.id],
          );
        } else if (change === 'revision') {
          await run(kit.env.DB, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [
            pass.id,
          ]);
        } else if (change === 'voided') {
          await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
        } else if (change === 'removed') {
          await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
            kit.clock.now(),
            pass.id,
          ]);
        } else {
          await run(
            kit.env.DB,
            'UPDATE pass_versions SET pass_json = json_set(pass_json, ?, ?) WHERE pass_id = ? AND version = ?',
            ['$.expirationDate', '2020-01-01T00:00:00Z', pass.id, pass.version],
          );
        }
        return offersFor(pass);
      });
      const response = await get(`/api/v1/me/passes/${pass.id}`, headers);
      expect(lookup).toHaveBeenCalledWith(expect.anything(), pass.id);
      const body = await response.text();
      expect(body).not.toContain('private-google-token');
      expect(body).not.toContain('private-samsung-token');
      // A pass that keeps changing while it is built is refused after three reads; a settled one
      // is read again from its current row, which no longer offers anything.
      if (change === 'generation' || change === 'revision') {
        expect(response.status).toBe(409);
        expect(JSON.parse(body)).toMatchObject({ code: 'PASS_CHANGING' });
        return;
      }
      expect(response.status).toBe(200);
      expect(JSON.parse(body)).toMatchObject({ presentationEligible: false, walletOffers: [] });
    },
    120_000,
  );

  it('drops holder capabilities if the organization is suspended during lookup', async () => {
    const pass = await ownPass();
    lookup.mockImplementation(async (_ctx, id) => {
      if (id !== pass.id) return [];
      await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
      return offersFor(pass);
    });
    try {
      const response = await get(`/api/v1/me/passes/${pass.id}`, headers);
      expect(response.status).toBe(200);
      expect(lookup).toHaveBeenCalledWith(expect.anything(), pass.id);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ presentationEligible: false, walletOffers: [] });
      expect(body).not.toContain('private-google-token');
      expect(body).not.toContain('private-samsung-token');
    } finally {
      await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    }
  }, 120_000);

  it('does not return a public page after its bearer changes during offer lookup', async () => {
    const pass = await ownPass();
    let replacement = '';
    lookup.mockImplementation(async (_ctx, id) => {
      if (id !== pass.id) return [];
      replacement = (await transfer(pass)).downloadToken;
      return offersFor(pass);
    });
    const response = await get(`/p/${pass.downloadToken}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(lookup).toHaveBeenCalledWith(expect.anything(), pass.id);
    const html = await response.text();
    expect(html).not.toContain(replacement);
    expect(html).not.toContain('/wallet/google');
    expect(html).not.toContain('/wallet/samsung');
    expect(html).not.toContain('private-google-token');
  }, 120_000);
});
