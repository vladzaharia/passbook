// CAND-1: Samsung system candidates are not stranded. While Samsung is dark nothing is queued; at the flip the
// backfill queues the Apple release; a Live card that is not launched yet is a skip, and the sweep drives it again
// later, reusing the candidate, until the release exists.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { samsungCompiler } from '../../../passkit/wallets/samsung/index.ts';
import { all } from '../../platform/db.ts';
import { createJobContext, createServiceContext } from '../../platform/service-context.ts';
import { getLatestRelease } from '../templates/repo-releases.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { runSystemProjection } from './projection-system.ts';
import { SYSTEM_REVIEWER } from './projection-system-authority.ts';
import { backfillSystemProjections } from './projection-system-backfill.ts';
import { queueSystemProjections } from './projection-system-queue.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';

afterEach(() => vi.restoreAllMocks());

type Fixture = Awaited<ReturnType<typeof setupWalletOfferKit>>;
type Job = Parameters<typeof runSystemProjection>[1];

const ctxWith = (f: Fixture, sent: unknown[]) =>
  createServiceContext(
    {
      ...f.kit.env,
      JOBS: {
        sendBatch: async (m: { body: unknown }[]) => void sent.push(...m.map((j) => j.body)),
      },
    } as never,
    { clock: f.kit.clock },
  );
const mine = (f: Fixture, sent: unknown[]) =>
  sent.filter((j) => (j as { orgId: string }).orgId === f.kit.org.id) as Job[];
const releases = (f: Fixture) =>
  getLatestRelease(f.kit.env.DB, {
    templateId: f.kit.template.id,
    orgId: f.kit.org.id,
    mode: 'live',
    provider: 'samsung',
  });
const candidates = (f: Fixture) =>
  all(
    f.kit.env.DB,
    "SELECT id FROM template_candidates WHERE org_id = ? AND provider = 'samsung'",
    [f.kit.org.id],
  );

async function run(f: Fixture, job: Job, state: string) {
  const card = f.mockTemplateFetch(f.googleCertificate, { state });
  try {
    await runSystemProjection(
      createJobContext(f.kit.env, 'wallet.projection_system', { clock: f.kit.clock }),
      job,
    );
  } finally {
    card.mockRestore();
  }
}

describe('Samsung system candidates are not stranded (CAND-1)', () => {
  it('waits while dark, publishes on the drain after the flip, and drives a Live card launched later', async () => {
    const f = await setupWalletOfferKit({
      google: 'absent',
      samsung: 'configured',
      enrolled: true,
    });
    const { kit } = f;
    const sent: unknown[] = [];
    const ctx = ctxWith(f, sent);

    // Dark: an Apple release queues nothing for Samsung, and neither does the sweep.
    const dark = setWalletProvidersEnabledForTest(false);
    await queueSystemProjections(ctx, {
      id: f.apple.id,
      templateId: kit.template.id,
      orgId: kit.org.id,
      mode: 'live',
      provider: 'apple',
      version: kit.template.version,
    } as never);
    await backfillSystemProjections(ctx);
    dark();
    expect(mine(f, sent)).toEqual([]);

    // The flip: the first drain queues the Apple release. The Live card is still in review, so the job skips.
    const open = setWalletProvidersEnabledForTest(true);
    try {
      kit.clock.advance(1000);
      await backfillSystemProjections(ctx);
      const [job] = mine(f, sent);
      expect(mine(f, sent)).toHaveLength(1);
      if (!job) throw new Error('No job.');
      expect(job).toMatchObject({ provider: 'samsung', sourceReleaseId: f.apple.id });
      await run(f, job, 'VERIFYING');
      expect(await releases(f)).toBeNull();
      expect(await candidates(f)).toHaveLength(1);

      // Not driven again before the back-off, and not when the card is still in review.
      kit.clock.advance(60_000);
      await backfillSystemProjections(ctx);
      expect(mine(f, sent)).toHaveLength(1);

      // The card launches; the sweep drives the stranded candidate again and the job reuses it.
      kit.clock.advance(16 * 60_000);
      await backfillSystemProjections(ctx);
      expect(mine(f, sent)).toHaveLength(2);
      await run(f, mine(f, sent)[1] as Job, 'ACTIVE');
      expect(await releases(f)).toMatchObject({ createdBy: SYSTEM_REVIEWER, generation: 1 });
      expect(await candidates(f)).toHaveLength(1);

      // Released: covered, and nothing more is queued.
      kit.clock.advance(16 * 60_000);
      await backfillSystemProjections(ctx);
      expect(mine(f, sent)).toHaveLength(2);
    } finally {
      open();
    }
  });

  /** An enrolled Samsung kit, flipped, with its first job skipped because the Live card is in review. */
  async function stranded() {
    const f = await setupWalletOfferKit({
      google: 'absent',
      samsung: 'configured',
      enrolled: true,
    });
    const sent: unknown[] = [];
    const ctx = ctxWith(f, sent);
    const open = setWalletProvidersEnabledForTest(true);
    f.kit.clock.advance(1000);
    await backfillSystemProjections(ctx);
    await run(f, mine(f, sent)[0] as Job, 'VERIFYING');
    return { f, sent, ctx, open };
  }

  it('replaces a stranded candidate that went stale, and supersedes the old one', async () => {
    const { f, sent, ctx, open } = await stranded();
    const { revision, compile } = samsungCompiler;
    try {
      const [old] = (await candidates(f)) as { id: string }[];
      // A compiler bump changes the pipeline pin: the stranded candidate can no longer be released.
      samsungCompiler.revision = revision + 1;
      samsungCompiler.compile = compile;
      f.kit.clock.advance(16 * 60_000);
      await backfillSystemProjections(ctx);
      expect(mine(f, sent)).toHaveLength(2);
      await run(f, mine(f, sent)[1] as Job, 'ACTIVE');
      const release = await releases(f);
      expect(release).toMatchObject({ createdBy: SYSTEM_REVIEWER, generation: 1 });
      expect(release?.candidateId).not.toBe(old?.id);
      expect(await candidates(f)).toHaveLength(2);
      // The released candidate covers the source; the stale one is ignored.
      f.kit.clock.advance(16 * 60_000);
      await backfillSystemProjections(ctx);
      expect(mine(f, sent)).toHaveLength(2);
    } finally {
      samsungCompiler.revision = revision;
      samsungCompiler.compile = compile;
      open();
    }
  });

  it('backs off the re-drive of a card that never launches: 15 minutes, then doubling', async () => {
    const { f, sent, ctx, open } = await stranded();
    try {
      const sweep = async (minutes: number) => {
        f.kit.clock.advance(minutes * 60_000);
        await backfillSystemProjections(ctx);
        return mine(f, sent).length;
      };
      expect(mine(f, sent)).toHaveLength(1);
      expect(await sweep(5)).toBe(1);
      expect(await sweep(11)).toBe(2);
      expect(await sweep(16)).toBe(3);
      expect(await sweep(16)).toBe(3);
      expect(await sweep(16)).toBe(4);
    } finally {
      open();
    }
  });
});
