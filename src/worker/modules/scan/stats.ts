import type { ScanCounts } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  credentialRefKeysetCommitment,
} from '../passes/credential-keyset.ts';
import { planCounts } from './counts.ts';
import type { ScanActor } from './guard.ts';
import {
  SESSION_READ,
  scanAuthorizedStmt,
  scanReadAuthority,
  scanReadFence,
} from './repo-read-authority.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { staleScanRead } from './stale-read.ts';

/** The door's counts for the actor's day, read under the same authority fence as the session. */
export async function statsFor(
  source: ServiceContext,
  scanActor: ScanActor,
  dayStart: number | undefined,
): Promise<ScanCounts> {
  const ctx = { ...source, env: { ...source.env } };
  const actor = cloneObservedScanActor(scanActor);
  // Counts are reads: no keyset bootstrap. The commitment only fences the expected-count cache write.
  actor.credentialKeysetCommitment = await credentialRefKeysetCommitment(
    captureCredentialKeyEnv(ctx.env),
  );
  // Epochs cover credential, configuration and staff changes; reads carry no CSRF proof.
  const auth = scanReadAuthority(actor, { now: ctx.clock.now(), read: SESSION_READ });
  // The cache write is guarded by the strict fence: a paused or staffless actor reads but never fills.
  const strict = scanReadAuthority(actor, { now: ctx.clock.now() });
  const plan = planCounts(ctx, actor, dayStart, actor, scanReadFence(strict));
  // The door polls this: only a lost credential unpairs, drift is a 409 the client reloads.
  const results = await ctx.env.DB.batch([scanAuthorizedStmt(ctx.env.DB, auth), ...plan.stmts]);
  if ((results[0]?.results?.[0] as { authorized?: number } | undefined)?.authorized !== 1)
    throw await staleScanRead(ctx, actor);
  return (await plan.read(results.slice(1))).counts;
}
