// Shared by the backfill tests: a Google enrolment on the offers kit, a counting queue, and a sweep.
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { first, run } from '../../platform/db.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { backfillSystemProjections } from './projection-system-backfill.ts';

export type Fixture = Awaited<ReturnType<typeof enrolled>>;

export const enrolled = async () => {
  const f = await setupWalletOfferKit({ google: 'configured', samsung: 'absent', enrolled: true });
  const row = await first<{ id: string }>(
    f.kit.env.DB,
    "SELECT id FROM wallet_provider_accounts WHERE org_id = ? AND provider = 'google'",
    [f.kit.org.id],
  );
  if (!row) throw new Error('No enrolment.');
  return { f, accountId: row.id };
};
export const withJobs = (x: Fixture, sent: unknown[]): ServiceContext =>
  createServiceContext(
    {
      ...x.f.kit.env,
      JOBS: {
        sendBatch: async (m: { body: unknown }[]) => void sent.push(...m.map((j) => j.body)),
      },
    } as never,
    { clock: x.f.kit.clock },
  );
export const queued = (x: Fixture, sent: unknown[]) =>
  sent.filter((j) => (j as { orgId: string }).orgId === x.f.kit.org.id);
export const job = (x: Fixture) => ({
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
export const bypass = (x: Fixture, set: string, ...params: number[]) =>
  RULES.reduceRight<() => Promise<unknown>>(
    (next, name) => () => withoutTrigger(x.f.kit.env.DB, name, next),
    () =>
      run(x.f.kit.env.DB, `UPDATE wallet_provider_accounts SET ${set} WHERE id = ?`, [
        ...params,
        x.accountId,
      ]),
  )();
export const drain = async (x: Fixture, sent: unknown[]) => {
  x.f.kit.clock.advance(1000);
  await backfillSystemProjections(withJobs(x, sent));
};
