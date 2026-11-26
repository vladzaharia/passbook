import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import type { createApp as CreateApp } from '../../app.ts';
import type {
  NotFoundError as NotFound,
  UnavailableError as Unavailable,
} from '../../platform/errors.ts';
import type { jobCtxOf as JobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import type { createPassRow as CreatePassRow } from '../passes/create.ts';
import type { Kit, setupKit as SetupKit } from '../passes/pass-test-fixtures.ts';
import type {
  issueWalletOfferScoped as IssueScoped,
  issueWalletOffer as IssueWalletOffer,
  listWalletOffers as ListWalletOffers,
} from '../wallet-providers/offers.ts';
import type { GoogleMemberFailedError as Failed } from '../wallet-providers/offers-google.ts';
import type { seedBundlePrincipal as SeedBundlePrincipal } from './test-auth-fixtures.ts';

// Only the eligibility and issuing results are stubbed; the gate itself is tested with the offers.
vi.mock('../wallet-providers/offers.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWalletOffers: vi.fn(),
  issueWalletOffer: vi.fn(),
  issueWalletOfferScoped: vi.fn(),
}));
vi.mock('../wallet-providers/runtime-google-bundle.ts', () => ({
  combineGoogleRuntimeOffers: vi.fn(async () => 'https://pay.google.test/gp/v/save/all'),
}));

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
const SAVE = 'https://pay.google.test/gp/v/save/jwt';
let kit: Kit;
let app: ReturnType<typeof CreateApp>;
let jobCtxOf: typeof JobCtxOf;
let createPassRow: typeof CreatePassRow;
let seedBundlePrincipal: typeof SeedBundlePrincipal;
let list: ReturnType<typeof vi.mocked<typeof ListWalletOffers>>;
let scoped: ReturnType<typeof vi.mocked<typeof IssueScoped>>;
let issue: ReturnType<typeof vi.mocked<typeof IssueWalletOffer>>;
let NotFoundError: typeof NotFound;
let UnavailableError: typeof Unavailable;
let GoogleMemberFailedError: typeof Failed;
let restore: () => void;

beforeAll(async () => {
  vi.resetModules();
  const { setupKit }: { setupKit: typeof SetupKit } = await import(
    '../passes/pass-test-fixtures.ts'
  );
  const { createApp }: { createApp: typeof CreateApp } = await import('../../app.ts');
  ({ jobCtxOf } = await import('../delivery/delivery-test-fixtures.ts'));
  ({ createPassRow } = await import('../passes/create.ts'));
  ({ seedBundlePrincipal } = await import('./test-auth-fixtures.ts'));
  ({ NotFoundError, UnavailableError } = await import('../../platform/errors.ts'));
  ({ GoogleMemberFailedError } = await import('../wallet-providers/offers-google.ts'));
  const offers = await import('../wallet-providers/offers.ts');
  list = vi.mocked(offers.listWalletOffers);
  issue = vi.mocked(offers.issueWalletOffer);
  scoped = vi.mocked(offers.issueWalletOfferScoped);
  const policy = await import('../wallet-providers/provider-policy.ts');
  restore = policy.setWalletProvidersEnabledForTest(true);
  kit = await setupKit();
  app = createApp({ stores: fake.stores, clock: kit.clock });
});

afterAll(() => restore());

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue([]);
  issue.mockReset();
  issue.mockResolvedValue(SAVE);
  scoped.mockReset();
});

async function bundleOfTwo() {
  const passes = [];
  for (let i = 0; i < 2; i++)
    passes.push(
      await createPassRow(jobCtxOf(kit), {
        orgId: kit.org.id,
        templateId: kit.template.id,
        templateVersion: kit.template.version,
        input: { memberName: `Member ${i}` },
        source: 'manual',
        execution: { kind: 'system' },
        mode: 'live',
        actor: { type: 'system', id: null },
      }),
    );
  const headers = fake.admin({ mode: 'live' });
  await seedBundlePrincipal(kit, fake, headers);
  const res = await app.request(
    `${ORIGIN}/api/v1/bundles`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: kit.org.id, name: 'Trip', passIds: passes.map((p) => p.id) }),
    },
    kit.env,
  );
  const body = (await res.json()) as { url: string };
  return { passes, token: body.url.split('/b/')[1] ?? '' };
}
const get = (path: string) => app.request(`${ORIGIN}${path}`, {}, kit.env);

describe('bundle save links for native wallets', () => {
  it('links each pass the offer list allows, by bundle path, never by pass token', async () => {
    const { passes, token } = await bundleOfTwo();
    const [first, second] = passes;
    list.mockImplementation(async (_ctx, passId) =>
      passId === first?.id
        ? [
            {
              provider: 'google',
              href: `/p/${first.downloadToken}/wallet/google`,
              installation: 'unknown',
            },
          ]
        : [],
    );
    const html = await (await get(`/b/${token}`)).text();
    expect(html).toContain(`href="/b/${token}/${first?.id}/wallet/google"`);
    expect(html).toContain('Add to Google Wallet');
    expect(html).not.toContain(`/b/${token}/${second?.id}/wallet/`);
    expect(html).not.toContain('Add to Samsung Wallet');
    for (const p of passes) expect(html).not.toContain(p.downloadToken);
  });

  it('shows no wallet link while no offer is allowed (channel off, not released, not enrolled)', async () => {
    const { token } = await bundleOfTwo();
    const html = await (await get(`/b/${token}`)).text();
    expect(html).not.toContain('/wallet/google');
    expect(html).not.toContain('Add to Google Wallet');
  });

  it('redirects a member link to the provider save location with no caching', async () => {
    const { passes, token } = await bundleOfTwo();
    const res = await app.request(
      `${ORIGIN}/b/${token}/${passes[0]?.id}/wallet/google`,
      { redirect: 'manual' },
      kit.env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(SAVE);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(issue.mock.calls[0]?.[2]).toBe('google');
  });

  it('answers 404 when the offer is withheld or the pass is not in the bundle', async () => {
    const { passes, token } = await bundleOfTwo();
    issue.mockRejectedValue(
      new NotFoundError('This wallet offer is not available.', 'WALLET_OFFER_NOT_FOUND'),
    );
    expect((await get(`/b/${token}/${passes[0]?.id}/wallet/google`)).status).toBe(404);
    issue.mockResolvedValue(SAVE);
    const stranger = await kit.pass();
    expect((await get(`/b/${token}/${stranger.id}/wallet/google`)).status).toBe(404);
    expect((await get(`/b/${token}/${passes[0]?.id}/wallet/apple`)).status).toBe(422);
  });

  describe('one Google link for the bundle', () => {
    const scope = { accountId: 'a', accountRevision: 1 } as never;
    const offered = (passId: string) => [
      {
        provider: 'google' as const,
        href: `/p/${passId}/wallet/google`,
        installation: 'unknown' as const,
      },
    ];
    const ok = (id: string, over: Record<string, unknown> = {}) => ({
      location: SAVE,
      scope,
      google: { objectId: `1.${id}` as never, type: 'generic' as const, expiresAt: 9 },
      recheck: vi.fn(async () => {}),
      recordCopy: vi.fn(async () => {}),
      ...over,
    });
    const hit = (token: string, query = '') =>
      app.request(`${ORIGIN}/b/${token}/wallet/google${query}`, { redirect: 'manual' }, kit.env);

    it('gives two Google-offered passes one save link, and none for fewer', async () => {
      const { passes, token } = await bundleOfTwo();
      list.mockImplementation(async (_ctx, passId) => offered(passId));
      scoped.mockImplementation(async (_ctx, tokenOf) => ok(String(tokenOf)));
      const html = await (await get(`/b/${token}`)).text();
      expect(html).toContain(`href="/b/${token}/wallet/google?part=0"`);
      expect(html).not.toContain('part=1');
      const res = await hit(token);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://pay.google.test/gp/v/save/all');
      expect(scoped).toHaveBeenCalledTimes(passes.length);
      for (const call of scoped.mock.results)
        expect((await call.value).recordCopy).toHaveBeenCalled();
      // No part past the last.
      expect((await hit(token, '?part=1')).status).toBe(404);
      // One offered member: no combined link is offered on the page, and the route has none.
      list.mockImplementation(async (_ctx, passId) =>
        passId === passes[0]?.id ? offered(passId) : [],
      );
      expect(await (await get(`/b/${token}`)).text()).not.toContain('/wallet/google?part');
      expect((await hit(token)).status).toBe(404);
    });

    it('answers 503 while a member is preparing, and leaves out one that failed for good', async () => {
      const { token } = await bundleOfTwo();
      list.mockImplementation(async (_ctx, passId) => offered(passId));
      let n = 0;
      scoped.mockImplementation(async () => {
        if (++n === 1)
          throw new UnavailableError('Google Wallet is not ready.', 'WALLET_PREPARING');
        return ok('x');
      });
      expect((await hit(token)).status).toBe(503);
      n = 0;
      scoped.mockImplementation(async () => {
        if (++n === 1)
          throw new GoogleMemberFailedError('Google Wallet is not ready.', 'WALLET_PREPARING');
        return ok('x');
      });
      const res = await hit(token);
      // The failed member is omitted; the one left is its own link.
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(SAVE);
    });

    it('answers 404 for members on different accounts, a member that goes stale, and records no copy', async () => {
      const { token } = await bundleOfTwo();
      list.mockImplementation(async (_ctx, passId) => offered(passId));
      let n = 0;
      const members = [ok('a'), ok('b', { scope: { accountId: 'other', accountRevision: 1 } })];
      scoped.mockImplementation(async () => members[n++ % 2] as never);
      expect((await hit(token)).status).toBe(404);
      expect(members[0]?.recordCopy).not.toHaveBeenCalled();
      // A member whose offer is no longer current at sign time fails the whole link, never a 500.
      const stale = ok('s', {
        recheck: vi.fn(async () => {
          throw new NotFoundError('This wallet offer is not available.', 'WALLET_OFFER_NOT_FOUND');
        }),
      });
      const { combineGoogleRuntimeOffers } = await import(
        '../wallet-providers/runtime-google-bundle.ts'
      );
      vi.mocked(combineGoogleRuntimeOffers).mockImplementationOnce(
        async (_c, _s, _o, assertCurrent) => {
          await assertCurrent?.();
          return 'x';
        },
      );
      scoped.mockImplementation(async () => stale as never);
      expect((await hit(token)).status).toBe(404);
      expect(stale.recordCopy).not.toHaveBeenCalled();
    });
  });
});
