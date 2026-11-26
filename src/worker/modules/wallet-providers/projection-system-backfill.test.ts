// CAND-1: a template released before the enrolment was On, or before the mode was released, gets provider
// candidates on the first drain after. Every case runs on a real enrolment (a source, On), not a legacy envelope.
import { describe, expect, it } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { first, run } from '../../platform/db.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { disableEnrolment } from './enrolment-service.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { createProjectionCandidate } from './projection-service.ts';
import { backfillSystemProjections } from './projection-system-backfill.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';

type Fixture = Awaited<ReturnType<typeof enrolled>>;

const enrolled = async () => {
  const f = await setupWalletOfferKit({ google: 'configured', samsung: 'absent', enrolled: true });
  const row = await first<{ id: string }>(
    f.kit.env.DB,
    "SELECT id FROM wallet_provider_accounts WHERE org_id = ? AND provider = 'google'",
    [f.kit.org.id],
  );
  if (!row) throw new Error('No enrolment.');
  return { f, accountId: row.id };
};
const withJobs = (x: Fixture, sent: unknown[]): ServiceContext =>
  createServiceContext(
    {
      ...x.f.kit.env,
      JOBS: {
        sendBatch: async (m: { body: unknown }[]) => void sent.push(...m.map((j) => j.body)),
      },
    } as never,
    { clock: x.f.kit.clock },
  );
const queued = (x: Fixture, sent: unknown[]) =>
  sent.filter((j) => (j as { orgId: string }).orgId === x.f.kit.org.id);
const job = (x: Fixture) => ({
  kind: 'wallet.projection_system',
  orgId: x.f.kit.org.id,
  mode: 'live',
  templateId: x.f.kit.template.id,
  sourceReleaseId: x.f.apple.id,
  version: x.f.kit.template.version,
  provider: 'google',
});
// The enable rules are lifted for the one update, as legacyOn does: a Live enable needs a Test round trip.
const RULES = [
  'wallet_enrolments_step',
  'wallet_enrolments_enable_source',
  'wallet_enrolments_enable_check',
  'wallet_enrolments_enable_round_trip',
];
const bypass = (x: Fixture, set: string, ...params: number[]) =>
  RULES.reduceRight<() => Promise<unknown>>(
    (next, name) => () => withoutTrigger(x.f.kit.env.DB, name, next),
    () =>
      run(x.f.kit.env.DB, `UPDATE wallet_provider_accounts SET ${set} WHERE id = ?`, [
        ...params,
        x.accountId,
      ]),
  )();
const drain = async (x: Fixture, sent: unknown[]) => {
  x.f.kit.clock.advance(1000);
  await backfillSystemProjections(withJobs(x, sent));
};

describe('candidate backfill (CAND-1)', () => {
  it('queues one job per uncovered Apple release, and only once', async () => {
    const x = await enrolled();
    const restore = setWalletProvidersEnabledForTest(true);
    try {
      const sent: unknown[] = [];
      await drain(x, sent);
      expect(queued(x, sent)).toEqual([job(x)]);
      await drain(x, sent);
      expect(queued(x, sent)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('queues again when the enrolment is turned Off and On again', async () => {
    const x = await enrolled();
    const restore = setWalletProvidersEnabledForTest(true);
    try {
      const sent: unknown[] = [];
      await drain(x, sent);
      expect(queued(x, sent)).toHaveLength(1);
      const revision = await first<{ r: number }>(
        x.f.kit.env.DB,
        'SELECT enrolment_revision AS r FROM wallet_provider_accounts WHERE id = ?',
        [x.accountId],
      );
      await disableEnrolment(x.f.kit.ctx, x.f.auth, x.f.kit.org.id, 'google', {
        expectedRevision: revision?.r ?? 0,
      });
      // Off: nothing, whatever the stamp.
      await drain(x, sent);
      expect(queued(x, sent)).toHaveLength(1);
      x.f.kit.clock.advance(1000);
      await bypass(x, 'enabled_at = ?', x.f.kit.clock.now());
      await drain(x, sent);
      expect(queued(x, sent)).toEqual([job(x), job(x)]);
      await drain(x, sent);
      expect(queued(x, sent)).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('queues nothing for a held or a revoked enrolment', async () => {
    const x = await enrolled();
    const restore = setWalletProvidersEnabledForTest(true);
    try {
      const sent: unknown[] = [];
      await bypass(x, 'platform_hold_at = ?, projection_backfilled_at = NULL', x.f.kit.clock.now());
      await drain(x, sent);
      expect(queued(x, sent)).toEqual([]);
      await bypass(x, 'platform_hold_at = NULL');
      // Revoked while still On: the production path turns it Off first, which would hide this clause.
      await withoutTrigger(x.f.kit.env.DB, 'wallet_enrolments_revoke_off', () =>
        withoutTrigger(x.f.kit.env.DB, 'wallet_enrolments_revoke_event', () =>
          run(x.f.kit.env.DB, 'UPDATE wallet_provider_accounts SET revoked_at = ? WHERE id = ?', [
            x.f.kit.clock.now(),
            x.accountId,
          ]),
        ),
      );
      await drain(x, sent);
      expect(queued(x, sent)).toEqual([]);
    } finally {
      restore();
    }
  });

  it('waits while the provider is dark, and queues on the first drain after it is released', async () => {
    const x = await enrolled();
    const sent: unknown[] = [];
    const dark = setWalletProvidersEnabledForTest(false);
    try {
      await drain(x, sent);
      expect(queued(x, sent)).toEqual([]);
    } finally {
      dark();
    }
    const open = setWalletProvidersEnabledForTest(true);
    try {
      await drain(x, sent);
      expect(queued(x, sent)).toEqual([job(x)]);
    } finally {
      open();
    }
  });

  it('skips a release that already has a candidate', async () => {
    const x = await enrolled();
    const restore = setWalletProvidersEnabledForTest(true);
    try {
      const sent: unknown[] = [];
      await createProjectionCandidate(x.f.kit.ctx, x.f.apple.authorAuth, x.f.kit.template.id, {
        orgId: x.f.kit.org.id,
        mode: 'live',
        provider: 'google',
        version: x.f.kit.template.version,
        sourceReleaseId: x.f.apple.id,
        projection: await x.f.candidateProjection('google'),
      });
      await drain(x, sent);
      expect(queued(x, sent)).toEqual([]);
    } finally {
      restore();
    }
  });
});
