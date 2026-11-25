import type { Json } from '../../../passkit/types.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { type Check, passRow } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { AppError, PreconditionFailedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  type PublishCommit,
  type PublishCommitDone,
  PublishDeclined,
  publishPass,
} from '../passes/publish.ts';
import type { Pass } from '../passes/repo-map.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { credentialFacts } from './act-check-in-facts.ts';
import type { ActRequest } from './act-claim.ts';
import { heldOutcome } from './act-held.ts';
import type { HeldHolder } from './act-held-holder.ts';
import { StaleScanAuthority } from './act-override.ts';
import { pendingCap } from './act-value-guard.ts';
import { assertPassStill, fillsCard, passChanged } from './act-value-mutate.ts';
import { finishValueResult, publishedPassJson } from './act-value-result.ts';
import {
  addValueStatements,
  gateUnchanged,
  type ValueScan,
  type ValueStatements,
} from './act-value-statements.ts';
import { historyPlan } from './card.ts';
import { type CountsPlan, localDayStart, planCommitCounts } from './counts.ts';
import { appliedAmount, ScanEffectStop, type ValueEffect, valueEffect } from './effects-value.ts';
import type { ScanActor } from './guard.ts';
import type { LedgerFacts } from './ledger.ts';
import type * as gates from './repo-gates.ts';
import type { Candidate } from './repo-lookup.ts';
import { filledSinceRedeem } from './repo-scan-amount.ts';
import { dailyAmountCheck, doneOkPredicate, effectiveReleaseCheck } from './repo-scan-checks.ts';
import type { Found } from './resolve.ts';
import { afterReads } from './scan-capture.ts';
import { displayRequiresHistory } from './scan-display-history.ts';
import type { StopAuthority } from './scan-stop-authority.ts';
import type { ScanApprover } from './scan-write-grant.ts';
import { SCAN_COMMIT_TABLES, scanWriteGrant } from './scan-write-grant.ts';
import type { PinReservation } from './staff-pin.ts';

export interface ValueInput {
  ctx: ServiceContext;
  actor: ScanActor;
  found: Found;
  req: ActRequest;
  reservation: PinReservation | null;
  action: ResolvedScanAction;
  undoWindow: number;
  gate: gates.GateKey;
  claim: gates.GateClaim;
  stopAuthority: StopAuthority;
  originalCandidate: Candidate | null;
  facts: Omit<LedgerFacts, 'outcome' | 'reason'>;
  approver: ScanApprover | null;
  onFailureCommitted(): void;
}

const VALUE_TABLES = [...SCAN_COMMIT_TABLES, 'passes'];
const CODES = {
  retention: 'SCAN_DAILY_LIMIT',
  stale: 'PASS_CONFLICT',
  lineage: 'PASS_CONFLICT',
  release: 'TEMPLATE_RELEASE_CONFLICT',
} as const;

/** One batch's worth of what the answer needs: the statements, the counts and the display reads. */
interface Planned {
  statements: ValueStatements;
  counts: CountsPlan;
  bound: ReturnType<Awaited<ReturnType<typeof historyPlan>>['bind']> | null;
  reads: ReturnType<typeof afterReads>;
}

const json = (value: Json) => JSON.stringify(value);

/**
 * A value action (SA 7.4): the pass is published and the scan row, gate and ledger event commit in
 * the same batch as its version, or none of them do. A pass that is already as asked closes the
 * scan in its own batch; a gate another scan took first closes it as that scan's heads-up.
 */
export async function commitValue(i: ValueInput): Promise<ScanOutcome> {
  const { ctx, actor, found, req, action, claim, gate, reservation } = i;
  const { actor: authority, approvedBy, event } = claim.authority;
  const manifest = found.template.manifest;
  const input = action.input ?? '';
  const body = { amount: req.amount, value: req.value };
  const credential =
    'code' in req.input
      ? await credentialFacts(found.pass, i.originalCandidate, req.input.code)
      : {};
  const plan = displayRequiresHistory(found) ? null : await historyPlan(ctx, actor, found);
  const scan: ValueScan = {
    ctx,
    actor,
    found,
    action,
    claim,
    gate,
    stopAuthority: i.stopAuthority,
    facts: i.facts,
    approvedBy,
    eventId: event?.id ?? null,
  };
  // Set by the publish's attempt that commits; closures cannot narrow a plain `let`.
  const st: {
    effect?: ValueEffect;
    planned?: Planned;
    results?: { writes: D1Result[]; after: D1Result[] };
    granted?: ReturnType<typeof open>;
  } = {};
  // The daily amount is held in the batch itself, as the effect applied (set by `mutate`).
  const limit = actor.settings.dailyAmount;
  const dailyLimit = () => {
    const applied = st.effect ? appliedAmount(st.effect) : 0;
    return limit != null && applied > 0 && (action.kind === 'add' || action.kind === 'take')
      ? [
          dailyAmountCheck(
            actor.actorKey,
            localDayStart(ctx.clock.now(), actor.timeZone),
            applied,
            limit,
          ),
        ]
      : [];
  };
  const open = (passChecks: Check[]) =>
    scanWriteGrant(ctx, authority, {
      purpose: 'org_mode.scan.value',
      now: ctx.clock.now(),
      event: event ?? null,
      pass: { id: found.pass.id, facts: { pass: found.pass, credential } },
      approver: i.approver,
      credentialRefs: claim.credentialTombstoneRefs,
      checks: [
        ...passChecks,
        effectiveReleaseCheck(found.pass.id, found.liveCandidate?.templateSnapshot?.raw),
        ...dailyLimit(),
      ],
      tables: VALUE_TABLES,
      codes: CODES,
    });
  const planBatch = async (
    g: ReturnType<typeof open>,
    passWon: ReturnType<typeof exists>,
    pass: Pass,
    effect: ValueEffect,
  ): Promise<Planned> => {
    const statements = await addValueStatements(g, scan, passWon, pass, {
      amount: action.kind === 'add' || action.kind === 'take' ? appliedAmount(effect) : null,
      before: json(effect.before),
      after: json(effect.after),
    });
    // The verified PIN's attempt comes back with the scan, in the same commit.
    if (reservation) g.include(...reservation.refundParts());
    const counts = planCommitCounts(ctx, actor, req.dayStart);
    const bound = plan?.bind(ctx.clock.now(), doneOkPredicate(claim.scanId)) ?? null;
    return {
      statements,
      counts,
      bound,
      reads: afterReads([...counts.stmts, ...(bound?.stmts ?? [])]),
    };
  };
  let fills = false;
  const commit: PublishCommit = {
    open: (passChecks) => open(passChecks),
    when: gateUnchanged(claim),
    async add(g, w): Promise<PublishCommitDone> {
      if (!st.effect) throw new StaleScanAuthority();
      const planned = await planBatch(
        g,
        exists('passes', { id: found.pass.id, version: w.version }),
        { ...found.pass, version: w.version },
        st.effect,
      );
      st.planned = planned;
      return {
        reads: planned.reads,
        settle(r, grant) {
          reservation?.markRefunded();
          st.results = r;
          st.granted = grant;
        },
      };
    },
  };

  let writtenJson: string | undefined;
  const stamps = manifest.stamps?.input === input;
  const filledBefore =
    stamps && action.kind === 'add' && manifest.stamps
      ? await filledSinceRedeem(
          ctx.env.DB,
          { orgId: actor.orgId, passId: found.pass.id },
          manifest.stamps.goal,
        )
      : false;
  const cap = await pendingCap(ctx, found, action);
  try {
    const published = await publishPass(ctx, {
      passId: found.pass.id,
      orgScope: actor.orgId,
      cause: authority.actor.type === 'user' ? 'admin' : 'api',
      source: 'scan',
      actor: authority.actor,
      ...(action.kind === 'set' && req.expectedVersion !== undefined
        ? { expectedVersion: req.expectedVersion }
        : {}),
      // A stamp card alerts once by itself (its template message); nothing else notifies unless asked.
      ...(action.notify || stamps ? {} : { notify: false }),
      budgetExempt: () => fills && !filledBefore,
      commit,
      transferPendingError: passChanged,
      mutate(current) {
        assertPassStill(current, found.pass, action);
        const effect = valueEffect(action, manifest, current, body, cap);
        st.effect = effect;
        fills = fillsCard(action, manifest.stamps, effect);
        return {
          personalization: effect.personalization,
          status: effect.status,
          fieldSources: input
            ? { ...current.fieldSources, [input]: 'manual' }
            : { ...current.fieldSources },
        };
      },
    });
    if (published.changed) writtenJson = published.passJson;
    const { effect, planned, results, granted } = st;
    if (!effect) throw new StaleScanAuthority();
    // A write that renders the same pass is stored without a version of its own, still in the batch.
    if (planned && results && granted)
      return await answer(planned, results, granted, published.pass, effect);
    if (published.changed) throw new StaleScanAuthority();
    return await closeUnchanged(published.pass, effect);
  } catch (error) {
    const { planned, results, granted } = st;
    if (error instanceof PublishDeclined && planned && results && granted)
      return await heldAnswer(planned, results, granted);
    if (error instanceof PreconditionFailedError) throw await staleStop();
    if (error instanceof AppError && error.code === CODES.retention)
      throw new ScanEffectStop('limit_reached');
    throw error;
  }

  /** The card moved since the staff read it: the heads-up names what it holds now. */
  async function staleStop(): Promise<ScanEffectStop> {
    const now = await getPass(ctx.env.DB, found.pass.id, actor.orgId);
    return new ScanEffectStop('stale', (now?.personalization[input] as Json | undefined) ?? null);
  }

  async function answer(
    p: Planned,
    r: { writes: D1Result[]; after: D1Result[] },
    g: NonNullable<(typeof st)['granted']>,
    pass: Pass,
    fx: ValueEffect,
  ): Promise<ScanOutcome> {
    const finishAt = ctx.clock.now();
    const read = await p.counts.read(r.after.slice(0, p.counts.stmts.length));
    const rows = (r.writes[g.indexOf(p.statements.finalOk)]?.results ?? []).length;
    if (!rows) {
      i.onFailureCommitted();
      return heldAnswer(p, r, g);
    }
    // A changed publish hands back the pass.json it wrote; an unchanged one stored no version of its own.
    const passJson = !plan
      ? null
      : writtenJson !== undefined
        ? (JSON.parse(writtenJson) as Found['passJson'])
        : await publishedPassJson(ctx, pass.id);
    return finishValueResult({
      ctx,
      actor,
      found,
      pass,
      action,
      scanId: claim.scanId,
      now: finishAt,
      undoWindow: i.undoWindow,
      read,
      effect: fx,
      amount: action.kind === 'add' || action.kind === 'take' ? appliedAmount(fx) : null,
      history: p.bound?.finalize(r.after.slice(p.counts.stmts.length)) ?? null,
      passJson,
    });
  }

  async function heldAnswer(
    p: Planned,
    r: { writes: D1Result[]; after: D1Result[] },
    g: NonNullable<(typeof st)['granted']>,
  ): Promise<ScanOutcome> {
    i.onFailureCommitted();
    const read = await p.counts.read(r.after.slice(0, p.counts.stmts.length));
    const holder = r.writes[g.indexOf(p.statements.holder)]?.results?.[0] as HeldHolder | undefined;
    return heldOutcome({
      ctx,
      actor,
      found,
      action,
      scanId: claim.scanId,
      reason: p.statements.lost,
      holder,
      read,
      display: null,
      now: ctx.clock.now(),
    });
  }

  /** The pass is as the action asks: the scan closes `ok` against the version it already has. */
  async function closeUnchanged(pass: Pass, fx: ValueEffect): Promise<ScanOutcome> {
    const g = open(passRow(pass.id, pass.rowVersion));
    const p = await planBatch(
      g,
      exists('passes', { id: pass.id, version: pass.version }),
      pass,
      fx,
    );
    const r = await g.commitWith(p.reads);
    reservation?.markRefunded();
    return answer(p, r, g, pass, fx);
  }
}
