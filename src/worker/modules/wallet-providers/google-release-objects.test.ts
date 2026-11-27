// A Google release reaches the objects already in wallets with no pass edit and no job of its own: the release
// insert marks every copy of the template dirty (0037, wallet_provider_dirty_release) and the minute drain sends
// each one under the release. Google applies class fields to every object by itself; what PassBook compiles
// into the object (the whole card on a Generic class) follows only because of this. A review result is not a
// release and sends nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompileResult } from '../../../passkit/wallets/types.ts';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { syncGoogleClassReviews } from './google-review-sync.ts';
import {
  barcode,
  fixture,
  mock,
  publishRelease,
  restore,
  text,
} from './google-runtime-test-fixtures.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import { updateCompiler } from './projection-v2-test-fixtures.ts';
import { drainWalletProviderSync } from './sync.ts';

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

const event =
  (name: string, ticketNumber: string) =>
  (result: CompileResult): CompileResult => ({
    ...result,
    type: 'event',
    classBody: {
      multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
      issuerName: 'Club',
      reviewStatus: 'UNDER_REVIEW',
      eventName: text(name),
    },
    objectBody: { state: 'ACTIVE', ticketNumber, barcode },
  });

const dirtyCount = async (db: D1Database) =>
  (await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM wallet_provider_instance_dirty'))?.n;
const writes = (mark: number, what: RegExp) =>
  mock.requests.slice(mark).filter((r) => r.method !== 'GET' && what.test(r.path));
const tickets = () => [...mock.google.eventTicketObject.values()].map((o) => o.ticketNumber);

/** Two saved objects of one class, with the dirty marks the taps left settled. */
async function setup() {
  const { f } = await fixture(event('Gala', 'T1'));
  const jobCtx = jobCtxOf(f.kit);
  for (const pass of [f.pass, await f.kit.pass({ holderEmail: 'b@example.test' })]) {
    const [offer] = await listWalletOffers(f.kit.ctx, pass.id);
    await issueWalletOffer(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google');
  }
  await drainWalletProviderSync(jobCtx);
  expect(await dirtyCount(f.kit.env.DB)).toBe(0);
  return { f, jobCtx };
}

describe('a second Google release and the objects already saved', () => {
  it('sends every object under it, once, and the class once', async () => {
    const { f, jobCtx } = await setup();
    restore.push(updateCompiler(event('Gala 2', 'T2'), 1));
    await publishRelease(f, 1);
    // Nobody edited a pass and no reconcile job ran: the release itself marked both copies.
    expect(await dirtyCount(f.kit.env.DB)).toBe(2);
    const mark = mock.requests.length;
    await drainWalletProviderSync(jobCtx);
    expect(tickets()).toEqual(['T2', 'T2']);
    expect(writes(mark, /eventTicketObject/)).toHaveLength(2);
    expect(writes(mark, /eventTicketClass/)).toHaveLength(1);
    expect(await dirtyCount(f.kit.env.DB)).toBe(0);
    // Nothing is left to send.
    const again = mock.requests.length;
    await drainWalletProviderSync(jobCtx);
    expect(writes(again, /walletobjects/)).toEqual([]);
  });

  it('sends nothing when Google reviews the class', async () => {
    const { f, jobCtx } = await setup();
    const [cls] = [...mock.google.eventTicketClass.values()];
    if (!cls) throw new Error('no class');
    cls.reviewStatus = 'APPROVED';
    f.kit.clock.advance(61_000);
    const mark = mock.requests.length;
    await syncGoogleClassReviews(jobCtx);
    await f.kit.settle();
    await drainWalletProviderSync(jobCtx);
    expect(writes(mark, /walletobjects/)).toEqual([]);
    expect(await dirtyCount(f.kit.env.DB)).toBe(0);
  });
});
