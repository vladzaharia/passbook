import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { createApp } from '../../app.ts';
import type { JobOf } from '../../jobs/types.ts';
import { all } from '../../platform/db.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';
import { handleUncertainRecheck } from './health-job.ts';
import {
  claimWalletOperation,
  markWalletClaimUncertain,
  newWalletClaimHandle,
} from './instance.ts';
import { fixture, reference } from './instance-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { UNCERTAIN_GRACE_MS } from './repo-sync-uncertain.ts';
import { walletJobCtx } from './wallet-job-ctx-test-fixtures.ts';

type F = Awaited<ReturnType<typeof fixture>>;
let f: F;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
const undo: (() => void)[] = [];

beforeAll(async () => {
  f = await fixture();
  auth = await setupTenantTestAuth(f.kit);
  app = createApp({ stores: auth.stores, clock: f.kit.clock });
}, 30_000);
afterEach(() => {
  for (const u of undo.splice(0)) u();
});

const orgId = () => f.pass.orgId;
const mode = () => f.pass.mode;
const url = (tail = '') => `https://wallet.test/api/v1/orgs/${orgId()}/wallet-health${tail}`;
const get = (headers: Record<string, string>) => app.request(url(), { headers }, f.kit.env);
const recheck = (headers: Record<string, string>, provider = 'samsung') =>
  app.request(
    url(`/${provider}/recheck`),
    { method: 'POST', headers: { ...headers, 'content-type': 'application/json' } },
    f.kit.env,
  );
const open = () => undo.push(setWalletProvidersEnabledForTest(true));

describe('wallet health', () => {
  it('lists no wallet that is not released', async () => {
    const res = await get(auth.admin({ mode: mode() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it('refuses anonymous callers and plain users', async () => {
    open();
    expect((await get({})).status).toBe(401);
    await expectProblem(await get(auth.user()), 403, 'FORBIDDEN');
  });

  it('reports queued, then uncertain, and settles only past the grace window', async () => {
    open();
    const admin = auth.admin({ mode: mode() });
    const op = await f.create();
    const samsung = async () => {
      const body = (await (await get(admin)).json()) as {
        items: {
          provider: string;
          tone: string;
          queued: number;
          uncertain: number;
          uncertainWaiting: number;
        }[];
      };
      return body.items.find((i) => i.provider === 'samsung');
    };
    expect(await samsung()).toMatchObject({ queued: 1, uncertain: 0, tone: 'ok' });

    const now = f.kit.clock.now();
    const claim = { ...reference(op), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(walletJobCtx(f.kit.env.DB), claim)).toBe('claimed');
    expect(await markWalletClaimUncertain(walletJobCtx(f.kit.env.DB), claim)).toBe(true);
    expect(await samsung()).toMatchObject({
      queued: 0,
      uncertain: 1,
      uncertainWaiting: 1,
      tone: 'attention',
    });

    // Inside the window nothing is queued: the first attempt may still be in flight.
    const queue = f.kit.queue;
    const early = await recheck(admin);
    expect(early.status).toBe(202);
    expect(await early.json()).toEqual({ queued: 0, waiting: 1 });
    expect(queue.sent).toEqual([]);

    f.kit.clock.advance(UNCERTAIN_GRACE_MS + 1);
    const late = await recheck(admin);
    expect(await late.json()).toEqual({ queued: 1, waiting: 0 });
    const job = queue.sent[0] as JobOf<'wallet.uncertain_recheck'>;
    expect(job).toMatchObject({ kind: 'wallet.uncertain_recheck', provider: 'samsung' });
    await handleUncertainRecheck(job, walletJobCtx(f.kit.env.DB));
    expect(await samsung()).toMatchObject({ uncertain: 0, queued: 1 });
    const audits = await all<{ detail: string }>(
      f.kit.env.DB,
      `SELECT detail FROM audit_log WHERE org_id = ? AND action = 'wallet.uncertain_recheck'`,
      [orgId()],
    );
    expect(audits).toHaveLength(2);
  });

  it('refuses a recheck of a wallet that is not released', async () => {
    const res = await recheck(auth.admin({ mode: mode() }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
