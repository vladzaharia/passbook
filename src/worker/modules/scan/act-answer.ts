import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { CommittedScanUnconfirmed, StaleScanAuthority } from './act-override.ts';
import type { StopContext } from './act-stop.ts';
import { historyPlan } from './card.ts';
import { planCounts } from './counts.ts';
import { photoGrantUrl } from './member-photo.ts';
import { stopOutcome } from './outcome.ts';
import type { StopAuthority } from './repo-action-authority.ts';
import { candidateTemplateFenceStmt, templateFenceHolds } from './repo-resolve-outcome-current.ts';
import type { Stop } from './resolve.ts';
import { afterReads, capturingDb } from './scan-capture.ts';
import { scanWriteGrant } from './scan-write-grant.ts';

/**
 * Return an approval heads-up without retaining an idempotency claim: one grant batch deletes the
 * pending row, then counts, history and any photo grant follow and only decorate the answer.
 */
export async function answerWithoutRow(
  s: StopContext,
  stop: Stop,
  authority: StopAuthority,
): Promise<ScanOutcome> {
  const { ctx, actor } = s;
  const historyPlanForStop = stop.found
    ? await historyPlan(ctx, actor, stop.found, s.history)
    : null;
  const photo = s.photo;
  const g = scanWriteGrant(ctx, authority.actor, {
    purpose: 'org_mode.scan.stop',
    now: ctx.clock.now(),
    event: authority.event ?? null,
    ...(authority.templateId ? { templateId: authority.templateId } : {}),
    // The answer shows the pass's card: the pass and its presented credential must be as resolved.
    ...(stop.found
      ? {
          pass: { id: stop.found.pass.id, facts: { pass: stop.found.pass, credential: {} } },
          credentialRefs: s.credentialTombstoneRefs,
        }
      : {}),
  });
  const released = g.delete('scans', {
    where: { id: s.scanId, state: 'pending', at: s.claimAt },
    returning: ['id'],
  });
  const fence = stop.found?.liveCandidate;
  const committed = await g.commitWith(
    afterReads(fence ? [candidateTemplateFenceStmt(capturingDb(ctx.env.DB), fence)] : []),
  );
  if (!(committed.writes[g.indexOf(released)]?.results ?? []).length) {
    s.onFailureCommitted();
    throw new StaleScanAuthority();
  }
  if (fence && !templateFenceHolds(committed.after[0])) throw new CommittedScanUnconfirmed();
  const now = ctx.clock.now();
  const open = { sql: '1', params: [] };
  const counts = planCounts(
    { ...ctx, clock: { now: () => now } },
    actor,
    s.dayStart,
    authority.actor,
    open,
  );
  const bound = historyPlanForStop?.bind(now, open);
  const after = await ctx.env.DB.batch([...counts.stmts, ...(bound?.stmts ?? [])]);
  const read = await counts.read(after.slice(0, counts.stmts.length));
  const history = bound?.finalize(
    after.slice(counts.stmts.length, counts.stmts.length + bound.stmts.length),
  );
  const photoUrl =
    photo && stop.found ? photoGrantUrl(authority.actor, stop.found.pass.id, photo.grant) : null;
  return stopOutcome(ctx, actor, stop, read, { action: s.action, history, photoUrl });
}
