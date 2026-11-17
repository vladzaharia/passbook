import type { Json } from '../../../passkit/types.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { type Check, passRow } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { ConflictError, PreconditionFailedError } from '../../platform/errors.ts';
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
import { finishValueResult } from './act-value-result.ts';
import {
  addValueStatements,
  gateUnchanged,
  type ValueScan,
  type ValueStatements,
} from './act-value-statements.ts';
import { historyPlan } from './card.ts';
import { type CountsPlan, planCommitCounts } from './counts.ts';
import { amountOf, ScanEffectStop, type ValueEffect, valueEffect } from './effects-value.ts';
import type { ScanActor } from './guard.ts';
import type { LedgerFacts } from './ledger.ts';
import type { StopAuthority } from './repo-action-authority.ts';
import type * as gates from './repo-gates.ts';
import type { Candidate } from './repo-lookup.ts';
import { doneOkPredicate } from './repo-scan-checks.ts';
import type { Found } from './resolve.ts';
import { afterReads, capturingDb } from './scan-capture.ts';
import { displayRequiresHistory } from './scan-display-history.ts';
import { decorateScan, SCAN_COMMIT_TABLES, scanWriteGrant } from './scan-write-grant.ts';
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
  approver: { id: string; authEpoch: number } | null;
  onFailureCommitted(): void;
}

const VALUE_TABLES = [...SCAN_COMMIT_TABLES, 'passes'];
const CODES = {
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
  const side = { ...ctx, env: { ...ctx.env, DB: capturingDb(ctx.env.DB) } };
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
    sideDb: side.env.DB,
    approvedBy,
    eventId: event?.id ?? null,
  };
  const open = (passChecks: Check[]) =>
    scanWriteGrant(ctx, authority, {
      purpose: 'org_mode.scan.value',
      now: ctx.clock.now(),
      event: event ?? null,
      pass: { id: found.pass.id, facts: { pass: found.pass, credential } },
      approver: i.approver,
      credentialRefs: claim.credentialTombstoneRefs,
      checks: passChecks,
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
      amount: action.kind === 'add' || action.kind === 'take' ? amountOf(action, req.amount) : null,
      before: json(effect.before),
      after: json(effect.after),
    });
    const counts = planCommitCounts(ctx, actor, req.dayStart);
    const bound = plan?.bind(ctx.clock.now(), doneOkPredicate(claim.scanId)) ?? null;
    return {
      statements,
      counts,
      bound,
      reads: afterReads([...counts.stmts, ...(bound?.stmts ?? [])]),
    };
  };

  // Set by the publish's attempt that commits; closures cannot narrow a plain `let`.
  const st: {
    effect?: ValueEffect;
    planned?: Planned;
    results?: { writes: D1Result[]; after: D1Result[] };
    granted?: ReturnType<typeof open>;
  } = {};
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
          st.results = r;
          st.granted = grant;
        },
      };
    },
  };

  const stamps = manifest.stamps?.input === input;
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
      budgetExempt: () => fills,
      commit,
      mutate(current) {
        if (current.templateVersion !== found.pass.templateVersion)
          throw new ConflictError('The pass changed. Retry.', 'PASS_CONFLICT');
        if (current.status === 'voided') throw new ScanEffectStop('voided');
        const effect = valueEffect(action, manifest, current, body);
        st.effect = effect;
        const before = effect.before;
        fills =
          stamps &&
          action.kind === 'add' &&
          typeof before === 'number' &&
          typeof effect.after === 'number' &&
          before < (manifest.stamps?.goal ?? Infinity) &&
          effect.after >= (manifest.stamps?.goal ?? Infinity);
        return {
          personalization: effect.personalization,
          status: effect.status,
          fieldSources: input
            ? { ...current.fieldSources, [input]: 'manual' }
            : { ...current.fieldSources },
        };
      },
    });
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
    await decorateScan(ctx, reservation, []);
    const read = await p.counts.read(r.after.slice(0, p.counts.stmts.length));
    const rows = (r.writes[g.indexOf(p.statements.finalOk)]?.results ?? []).length;
    if (!rows) {
      i.onFailureCommitted();
      return heldAnswer(p, r, g);
    }
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
      amount: action.kind === 'add' || action.kind === 'take' ? amountOf(action, req.amount) : null,
      history: p.bound?.finalize(r.after.slice(p.counts.stmts.length)) ?? null,
    });
  }

  async function heldAnswer(
    p: Planned,
    r: { writes: D1Result[]; after: D1Result[] },
    g: NonNullable<(typeof st)['granted']>,
  ): Promise<ScanOutcome> {
    i.onFailureCommitted();
    await decorateScan(ctx, reservation, []);
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
    return answer(p, r, g, pass, fx);
  }
}
