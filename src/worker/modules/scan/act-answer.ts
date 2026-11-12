import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { StaleScanAuthority } from './act-override.ts';
import type { StopContext } from './act-stop.ts';
import { historyPlan } from './card.ts';
import { planCounts } from './counts.ts';
import { confirmedPhotoUrl } from './member-photo.ts';
import { stopOutcome } from './outcome.ts';
import type { StopAuthority } from './repo-action-authority.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { boundOutputPredicate } from './repo-output-predicates.ts';
import type { Stop } from './resolve.ts';
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
  if (photo && !stop.found?.liveCandidate) throw new StaleScanAuthority();
  const photoPlan =
    photo && stop.found?.liveCandidate
      ? await prepareAssetGrantInsertion(
          ctx,
          photo.grant,
          { recipientSnapshot: s.csrfSnapshot },
          stop.found.liveCandidate,
          { soft: true },
        )
      : null;
  const g = scanWriteGrant(ctx, authority.actor, {
    purpose: 'org_mode.scan.stop',
    now: ctx.clock.now(),
    event: authority.event ?? null,
    ...(authority.templateId ? { templateId: authority.templateId } : {}),
    // The answer shows the pass's card: its presented credential must not have been retired since.
    ...(stop.found ? { credentialRefs: { current: s.credentialTombstoneRefs, other: [] } } : {}),
  });
  const released = g.delete('scans', {
    where: { id: s.scanId, state: 'pending', at: s.claimAt },
    returning: ['id'],
  });
  const results = await g.commit();
  if (!(results[g.indexOf(released)]?.results ?? []).length) {
    s.onFailureCommitted();
    throw new StaleScanAuthority();
  }
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
  const insert = photoPlan ? photoPlan(now, boundOutputPredicate(open), open) : [];
  const after = await ctx.env.DB.batch([...counts.stmts, ...(bound?.stmts ?? []), ...insert]);
  const read = await counts.read(after.slice(0, counts.stmts.length));
  const history = bound?.finalize(
    after.slice(counts.stmts.length, counts.stmts.length + bound.stmts.length),
  );
  const photoUrl =
    photo && stop.found
      ? confirmedPhotoUrl(
          authority.actor,
          stop.found.pass.id,
          photo.grant,
          after.slice(counts.stmts.length + (bound?.stmts.length ?? 0)),
        )
      : null;
  return stopOutcome(ctx, actor, stop, read, { action: s.action, history, photoUrl });
}
