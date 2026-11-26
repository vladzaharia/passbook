// CAND-1: a template released before the enrolment was On, or before the mode was released, gets provider
// candidates on the first drain after.
import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { backfillSystemProjections } from './projection-system-backfill.ts';
import {
  candidateOf,
  installV2Env,
  type Kit,
  request,
  S,
  setup,
} from './projection-v2-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';

installV2Env();

const withJobs = (sent: unknown[]): ServiceContext =>
  createServiceContext(
    {
      ...S.env,
      JOBS: {
        sendBatch: async (m: { body: unknown }[]) => void sent.push(...m.map((x) => x.body)),
      },
    } as never,
    { clock: S.clock },
  );
/** What was queued for this kit's org: other tests' orgs share the database. */
const queued = (sent: unknown[], kit: Kit) =>
  sent.filter((j) => (j as { orgId: string }).orgId === kit.orgId);
const job = (kit: Kit) => ({
  kind: 'wallet.projection_system',
  orgId: kit.orgId,
  mode: 'live',
  templateId: kit.templateId,
  sourceReleaseId: kit.sourceId,
  version: kit.version,
  provider: 'google',
});
const account = (kit: Kit, set: string, ...params: number[]) =>
  run(
    S.env.DB,
    `UPDATE wallet_provider_accounts SET ${set} WHERE org_id = ? AND provider = 'google'`,
    [...params, kit.orgId],
  );

describe('candidate backfill (CAND-1)', () => {
  it('queues one job per uncovered Apple release, and only once', async () => {
    const kit = await setup();
    const restore = setWalletProvidersEnabledForTest(true);
    try {
      const sent: unknown[] = [];
      await backfillSystemProjections(withJobs(sent));
      expect(queued(sent, kit)).toEqual([job(kit)]);
      // Stamped: the next drain adds nothing.
      await backfillSystemProjections(withJobs(sent));
      expect(queued(sent, kit)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('waits while the provider is dark, and queues on the first drain after it is released', async () => {
    const kit = await setup();
    await account(kit, 'projection_backfilled_at = NULL');
    const sent: unknown[] = [];
    const dark = setWalletProvidersEnabledForTest(false);
    try {
      await backfillSystemProjections(withJobs(sent));
      expect(queued(sent, kit)).toEqual([]);
    } finally {
      dark();
    }
    const open = setWalletProvidersEnabledForTest(true);
    try {
      await backfillSystemProjections(withJobs(sent));
      expect(queued(sent, kit)).toEqual([job(kit)]);
    } finally {
      open();
    }
  });

  it('skips a release that already has a candidate', async () => {
    const kit = await setup();
    const restore = setWalletProvidersEnabledForTest(true);
    try {
      const sent: unknown[] = [];
      await candidateOf(kit, request());
      await backfillSystemProjections(withJobs(sent));
      expect(queued(sent, kit)).toEqual([]);
    } finally {
      restore();
    }
  });
});
