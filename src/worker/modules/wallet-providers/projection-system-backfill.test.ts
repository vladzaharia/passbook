// CAND-1: a template released before the enrolment was On, or before the mode was released, gets provider
// candidates on the first drain after. Every case runs on a real enrolment (a source, On), not a legacy envelope.
import { describe, expect, it } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { first, run } from '../../platform/db.ts';
import { disableEnrolment } from './enrolment-service.ts';
import { createProjectionCandidate } from './projection-service.ts';
import {
  bypass,
  drain,
  enrolled,
  job,
  queued,
} from './projection-system-backfill-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';

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

  it('does not stamp a suspended org, so reactivating it backfills', async () => {
    const x = await enrolled();
    const restore = setWalletProvidersEnabledForTest(true);
    try {
      const sent: unknown[] = [];
      await run(x.f.kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [
        x.f.kit.org.id,
      ]);
      await drain(x, sent);
      expect(queued(x, sent)).toEqual([]);
      await run(x.f.kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [x.f.kit.org.id]);
      await drain(x, sent);
      expect(queued(x, sent)).toEqual([job(x)]);
    } finally {
      restore();
    }
  });
});
