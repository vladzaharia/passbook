import type { ServiceContext } from '../../platform/service-context.ts';
import { probeGoogleIssuer } from './account-check-google.ts';
import { probeSamsungCards } from './account-check-samsung.ts';
import { type CheckOutcome, DAY_MS } from './account-check-types.ts';
import { snapshotWalletCredentialContext } from './account-credential-material.ts';
import { openSourceVersion, type SourceCredentials } from './account-credential-source.ts';
import {
  type CheckTarget,
  findCheck,
  findCheckTarget,
  listCheckableCredentials,
  writeCheck,
} from './repo-credential-checks.ts';

/** Decrypts the current version, confirms its identity, and asks the provider. Never throws on a provider fault. */
async function outcomeOf(ctx: ServiceContext, target: CheckTarget): Promise<CheckOutcome> {
  let source: SourceCredentials;
  try {
    // The credential's own org: the opener refuses a secret whose identity differs from the stored hash.
    source = await openSourceVersion(
      ctx,
      {
        id: '',
        orgId: target.credential_org_id ?? '',
        mode: target.mode,
        provider: target.provider,
      },
      target,
    );
  } catch {
    return { ok: false, code: 'credential_unreadable' };
  }
  return source.provider === 'google'
    ? probeGoogleIssuer(ctx, source.credentials)
    : probeSamsungCards(ctx, source.credentials, target.mode);
}

/** The id a daily check takes: one per credential version per UTC day, so a rerun of the cron adds nothing. */
export const dailyCheckId = (credentialId: string, versionId: string, now: number) =>
  `${credentialId}:${versionId}:${Math.floor(now / DAY_MS)}`;

/** Runs one check under its id and records it. A redelivered job finds its row and stops. */
export async function runCredentialCheck(
  ctx: ServiceContext,
  job: { credentialId: string; checkId: string },
): Promise<void> {
  ctx = snapshotWalletCredentialContext(ctx);
  const target = await findCheckTarget(ctx.env.DB, job.credentialId);
  if (!target || (await findCheck(ctx.env.DB, job.credentialId, job.checkId))) return;
  const outcome = await outcomeOf(ctx, target);
  try {
    await writeCheck(ctx, {
      checkId: job.checkId,
      eventId: ctx.ids.id(),
      target,
      ok: outcome.ok,
      code: outcome.code,
      verify: outcome.ok && target.scope === 'org' && target.verified_at === null,
    });
  } catch (error) {
    // A concurrent run of the same id, a rotation or a revoke moved the row under this check.
    if (await findCheck(ctx.env.DB, job.credentialId, job.checkId)) return;
    ctx.log.warn('wallet.credential_check_unwritten', { code: 'WALLET_CHECK_UNWRITTEN', error });
    return;
  }
  ctx.log.info('wallet.credential_check', {
    provider: target.provider,
    scope: target.scope,
    ok: outcome.ok,
    code: outcome.code,
  });
}

const SEND_BATCH = 100;
const PAGE = 200;

/** Queues the check of a version the day's id covers; a failed send is left to the daily run. */
export async function enqueueVersionCheck(
  ctx: ServiceContext,
  credentialId: string,
  versionId: string,
): Promise<void> {
  try {
    await ctx.env.JOBS.send({
      kind: 'wallet.credential_check',
      credentialId,
      checkId: dailyCheckId(credentialId, versionId, ctx.clock.now()),
    });
  } catch (error) {
    ctx.log.warn('wallet.credential_check_unqueued', { code: 'WALLET_CHECK_UNQUEUED', error });
  }
}

/** Daily: one check job per active credential, paged by id and sent in queue batches. */
export async function enqueueCredentialChecks(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  let after = '';
  let count = 0;
  for (;;) {
    const page = await listCheckableCredentials(ctx.env.DB, after, PAGE);
    for (let i = 0; i < page.length; i += SEND_BATCH)
      await ctx.env.JOBS.sendBatch(
        page.slice(i, i + SEND_BATCH).map((c) => ({
          body: {
            kind: 'wallet.credential_check' as const,
            credentialId: c.id,
            checkId: dailyCheckId(c.id, c.current_version_id, now),
          },
        })),
      );
    count += page.length;
    const last = page.at(-1);
    if (!last || page.length < PAGE) break;
    after = last.id;
  }
  ctx.log.info('wallet.credential_checks_queued', { count });
}
