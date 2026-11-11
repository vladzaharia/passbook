import type { ServiceContext } from '../../platform/service-context.ts';
import { type ActRequest, historyCapacity } from './act-claim.ts';
import { pickAction, StaleScanAuthority } from './act-override.ts';
import {
  type ActionHistoryPreflight,
  type ActionPreflightReadPlan,
  prepareCheckInReads,
} from './act-preflight.ts';
import type { ScanActor } from './guard.ts';
import {
  type PendingDisplayHistorySource,
  planPendingDisplayHistorySource,
} from './history-proof-pending.ts';
import {
  type PreloadedDisplayHistory,
  planDisplayHistoryRead,
  rebindDisplayHistoryRead,
} from './history-proof-plan.ts';
import { type ActionPassFence, prepareActionPassFence } from './repo-pass-authority.ts';
import type { Found } from './resolve.ts';
import type { EvaluationReadPlan } from './resolve-evaluate.ts';
import { displayNeedsFor } from './scan-display-history.ts';

export interface ActionReads {
  plan: ActionPreflightReadPlan | null;
  passFence: ActionPassFence | null;
  preloaded?: PreloadedDisplayHistory;
  history: ActionHistoryPreflight | null;
  prepare(found: Found): Promise<EvaluationReadPlan>;
  bind(actor: ScanActor, found: Found): void;
}

/** Capture all pass and history reads with admission, including chooser and refusal paths. */
export function planActionReads(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
  scanId: string,
): ActionReads {
  const histories = new Map<string | null, PreloadedDisplayHistory>();
  let source: PendingDisplayHistorySource | null = null;
  const reads: ActionReads = {
    plan: null,
    passFence: null,
    history: null,
    bind(effectiveActor, found) {
      if (!histories.size) return;
      const eventId = effectiveActor.event?.id ?? effectiveActor.scannerAssignment?.eventId ?? null;
      const preloaded = histories.get(eventId);
      if (!preloaded || !rebindDisplayHistoryRead(preloaded, effectiveActor, found))
        throw new StaleScanAuthority();
      reads.preloaded = preloaded;
      if (source) reads.history = { preloaded, source };
    },
    async prepare(found) {
      const picked = pickAction(actor, found.scan, req.actionId);
      const action = picked === 'choose' ? undefined : picked;
      const plan =
        action?.kind === 'check_in' ? prepareCheckInReads(ctx, actor, found, action) : null;
      if (action?.kind === 'check_in' && !plan) throw new StaleScanAuthority();
      reads.plan = plan;
      reads.passFence = null;
      reads.preloaded = undefined;
      reads.history = null;
      histories.clear();
      source = null;
      let base: EvaluationReadPlan;
      if (plan) base = plan;
      else {
        const prepared = prepareActionPassFence(
          ctx.env.DB,
          found.pass,
          found.checkInRules,
          found.connectionGeneration,
          found.activeVersion,
          found.orgRevision,
          found.templateRevision,
          ctx.clock.now(),
          ctx.env,
          found,
        );
        if (!prepared && picked !== 'choose') throw new StaleScanAuthority();
        base = prepared
          ? {
              stmts: [prepared.statement],
              async finish(results) {
                if (results.length !== 1) throw new StaleScanAuthority();
                reads.passFence = await prepared.complete(
                  results[0]?.results?.[0] as { rules: string | null } | undefined,
                );
              },
            }
          : {
              stmts: [],
              async finish(results) {
                if (results.length) throw new StaleScanAuthority();
              },
            };
      }
      const needs = displayNeedsFor(found);
      if (!needs.history.length && !needs.ledger.length) return base;
      const capacity = found.liveCandidate ? historyCapacity(found.liveCandidate) : undefined;
      if (capacity === undefined) throw new StaleScanAuthority();
      const originalEventId = actor.event?.id ?? actor.scannerAssignment?.eventId ?? null;
      const plannedEventId =
        actor.event?.id ??
        found.checkInRules?.eventId ??
        actor.settings.checkIn?.eventId ??
        actor.scannerAssignment?.eventId ??
        null;
      const pages = [...new Set([originalEventId, plannedEventId])].map((eventId) => ({
        eventId,
        plan: planDisplayHistoryRead(ctx, actor, found, needs, capacity, eventId),
      }));
      const pending = plan
        ? planPendingDisplayHistorySource(ctx, actor, found, scanId, needs)
        : null;
      return {
        stmts: [
          ...base.stmts,
          ...pages.flatMap((page) => page.plan.stmts),
          ...(pending?.stmts ?? []),
        ],
        async finish(results) {
          let offset = base.stmts.length;
          await base.finish(results.slice(0, offset));
          for (const page of pages) {
            const end = offset + page.plan.stmts.length;
            const loaded = await page.plan.finish(results.slice(offset, end));
            if (!loaded) throw new StaleScanAuthority();
            histories.set(page.eventId, loaded);
            offset = end;
          }
          if (pending) {
            source = pending.finish(results.slice(offset));
            if (!source) throw new StaleScanAuthority();
          } else if (results.length !== offset) throw new StaleScanAuthority();
        },
      };
    },
  };
  return reads;
}
