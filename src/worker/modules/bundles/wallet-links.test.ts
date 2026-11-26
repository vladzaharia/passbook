import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import type { createApp as CreateApp } from '../../app.ts';
import type { NotFoundError as NotFound } from '../../platform/errors.ts';
import type { jobCtxOf as JobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import type { createPassRow as CreatePassRow } from '../passes/create.ts';
import type { Kit, setupKit as SetupKit } from '../passes/pass-test-fixtures.ts';
import type {
  issueWalletOfferScoped as IssueScoped,
  issueWalletOffer as IssueWalletOffer,
  listWalletOffers as ListWalletOffers,
} from '../wallet-providers/offers.ts';
import type { seedBundlePrincipal as SeedBundlePrincipal } from './test-auth-fixtures.ts';

// Only the eligibility and issuing results are stubbed; the gate itself is tested with the offers.
vi.mock('../wallet-providers/offers.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWalletOffers: vi.fn(),
  issueWalletOffer: vi.fn(),
  issueWalletOfferScoped: vi.fn(),
}));
vi.mock('../wallet-providers/runtime-google-bundle.ts', () => ({
  combineGoogleRuntimeOffers: vi.fn(async () => ({
    url: 'https://pay.google.test/gp/v/save/all',
    expiresAt: 1,
  })),
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
  ({ NotFoundError } = await import('../../platform/errors.ts'));
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

  it('gives two Google-offered passes one save link, and none for fewer', async () => {
    const { passes, token } = await bundleOfTwo();
    list.mockImplementation(async (_ctx, passId) => [
      { provider: 'google', href: `/p/${passId}/wallet/google`, installation: 'unknown' },
    ]);
    const scope = { accountId: 'a', accountRevision: 1 } as never;
    scoped.mockImplementation(async () => ({ location: SAVE, scope }));
    const html = await (await get(`/b/${token}`)).text();
    expect(html).toContain(`href="/b/${token}/wallet/google?part=0"`);
    expect(html).not.toContain('part=1');
    const res = await app.request(
      `${ORIGIN}/b/${token}/wallet/google`,
      { redirect: 'manual' },
      kit.env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://pay.google.test/gp/v/save/all');
    expect(scoped).toHaveBeenCalledTimes(passes.length);
    // One offered member: no combined link is offered on the page.
    list.mockImplementation(async (_ctx, passId) =>
      passId === passes[0]?.id
        ? [{ provider: 'google', href: `/p/${passId}/wallet/google`, installation: 'unknown' }]
        : [],
    );
    expect(await (await get(`/b/${token}`)).text()).not.toContain('/wallet/google?part');
  });
});
