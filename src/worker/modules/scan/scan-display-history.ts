import {
  compileNeeds,
  defaultScanDisplay,
  type ScanDisplayNeeds,
} from '../../../passkit/template/scan-display/index.ts';
import type { Json } from '../../../passkit/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { captureDisplayHistoryScope, sameDisplayHistoryScope } from './history-display-scope.ts';
import {
  consumeDisplayHistoryRead,
  type PreloadedDisplayHistory,
  planDisplayHistoryRead,
} from './history-proof-plan.ts';
import { validCredentialKeysetCommitment } from './repo-credential-tombstones.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';
import {
  displayHistoryAuthorityStmt,
  displayHistoryCountsStmt,
  displayHistoryLineageStmt,
  displayHistoryTopStmt,
} from './repo-scan-display-history.ts';
import { historyPassScopePredicate } from './repo-scan-history.ts';
import type { Found } from './resolve.ts';
import {
  boundaries,
  type DisplayRow,
  genericHistory,
  type HistoryScope,
  render,
} from './scan-display-history-view.ts';

const finalized = Symbol('finalized-scan-display-history');
const owners = new WeakMap<object, { actor: ScanActor; found: Found; scope: readonly unknown[] }>();

/** Only created after the same-batch actor/pass authority and every history snapshot pass. */
export interface FinalizedDisplayHistory {
  readonly value: Json;
  readonly [finalized]: true;
}

/** Reject raw histories and histories made for another actor, role or pass snapshot. */
export function isFinalizedDisplayHistory(
  value: unknown,
  actor: ScanActor,
  found: Found,
): value is FinalizedDisplayHistory {
  if (
    value === null ||
    typeof value !== 'object' ||
    !(finalized in value) ||
    value[finalized] !== true
  )
    return false;
  const owner = owners.get(value);
  return (
    !!owner &&
    owner.actor === actor &&
    owner.found === found &&
    sameDisplayHistoryScope(owner.scope, captureDisplayHistoryScope(actor, found))
  );
}

export interface BoundDisplayHistory {
  readonly stmts: D1PreparedStatement[];
  /** Results must be the corresponding statements from the caller's final D1 batch. */
  finalize(results: readonly D1Result[]): FinalizedDisplayHistory | null;
}

export interface DisplayHistoryPlan {
  /** False only when neither history nor ledger values are requested by the display. */
  readonly requiresHistory: boolean;
  /** Authority must bind the original actor, pass, release and any committed gate in this batch. */
  bind(now: number, authority: OutputPredicate): BoundDisplayHistory;
}

/** Resolve display dependencies once using the same default as card rendering. */
export function displayNeedsFor(found: Found): ScanDisplayNeeds {
  return compileNeeds(
    found.scan.display ?? defaultScanDisplay(found.template.manifest, found.passJson),
  );
}

function requiresHistory(needs: ScanDisplayNeeds): boolean {
  return needs.history.length > 0 || needs.ledger.length > 0;
}

/** Let callers skip pre-commit history reads only when the display does not use them. */
export function displayRequiresHistory(found: Found): boolean {
  return requiresHistory(displayNeedsFor(found));
}

function isHistoryRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function freezeJson(value: Json): Json {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function stamp(
  value: Json,
  actor: ScanActor,
  found: Found,
  scope: readonly unknown[],
): FinalizedDisplayHistory {
  const result = Object.freeze<FinalizedDisplayHistory>({
    value: freezeJson(value),
    [finalized]: true,
  });
  owners.set(result, { actor, found, scope });
  return result;
}

/**
 * Plan a pass's historical display from bounded, signed event proofs. The returned statements
 * must run alongside the caller's final actor/pass/gate authority in one D1 batch; no history
 * leaves this module until finalize validates that transaction: the authority holds, the counts
 * and newest scans still match what was read, and the pass is still the one it was read for.
 */
export async function prepareDisplayHistory(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  needs: ScanDisplayNeeds,
  preloaded?: PreloadedDisplayHistory | null,
): Promise<DisplayHistoryPlan> {
  const db = ctx.env.DB;
  const requested = requiresHistory(needs);
  const originalScope = captureDisplayHistoryScope(actor, found);
  const scopeSnapshot: HistoryScope = {
    orgId: actor.orgId,
    mode: actor.mode,
    credentialKeysetCommitment: found.credentialKeysetCommitment,
    passId: found.pass.id,
    templateId: found.pass.templateId,
    eventId: actor.event?.id ?? actor.scannerAssignment?.eventId ?? null,
    timeZone: actor.timeZone,
    role: actor.role,
  };
  let token = preloaded;
  if (token === undefined) {
    const plan = planDisplayHistoryRead(ctx, actor, found, needs);
    const result = plan.stmts.length ? await db.batch(plan.stmts) : [];
    token = await plan.finish(result);
  }
  const loaded = token ? await consumeDisplayHistoryRead(token, actor, found, needs) : null;
  const rows: DisplayRow[] = [];
  let complete = loaded !== null;
  for (const id of loaded?.ids ?? []) {
    const row = loaded?.rows.get(id);
    if (row) rows.push(row);
    else complete = false;
  }

  return {
    requiresHistory: requested,
    bind(now, authority) {
      const current =
        !!loaded &&
        sameDisplayHistoryScope(captureDisplayHistoryScope(actor, found), originalScope) &&
        validCredentialKeysetCommitment(actor.credentialKeysetCommitment) &&
        validCredentialKeysetCommitment(scopeSnapshot.credentialKeysetCommitment) &&
        actor.credentialKeysetCommitment === scopeSnapshot.credentialKeysetCommitment;
      const statements = [displayHistoryAuthorityStmt(db, current, authority)];
      if (requested) {
        const scope = historyPassScopePredicate(scopeSnapshot, now);
        statements.push(
          displayHistoryCountsStmt(db, scope, boundaries(now, scopeSnapshot.timeZone).today),
          displayHistoryTopStmt(db, scope),
          displayHistoryLineageStmt(db, {
            orgId: found.pass.orgId,
            mode: found.pass.mode,
            passId: found.pass.id,
            credentialGeneration: found.pass.credentialGeneration,
            lifecycleGeneration: found.pass.lifecycleGeneration,
          }),
        );
      }
      let consumed = false;
      return {
        stmts: statements,
        finalize(results) {
          if (consumed) return null;
          consumed = true;
          const authorityRow = results[0]?.results?.[0];
          if (
            results.length !== statements.length ||
            !isHistoryRow(authorityRow) ||
            authorityRow.authorized !== 1 ||
            !sameDisplayHistoryScope(captureDisplayHistoryScope(actor, found), originalScope)
          )
            return null;
          if (!requested) return stamp({}, actor, found, originalScope);
          const countsRow = results[1]?.results?.[0];
          const generic: { scans: { total: number; today: number } } | null = genericHistory(
            isHistoryRow(countsRow) ? countsRow : undefined,
          );
          if (!generic) return stamp({}, actor, found, originalScope);
          const top = results[2]?.results;
          if (!top) return stamp(generic, actor, found, originalScope);
          const topIds: string[] = [];
          for (const row of top) {
            if (!isHistoryRow(row) || typeof row.id !== 'string' || topIds.includes(row.id))
              return stamp(generic, actor, found, originalScope);
            topIds.push(row.id);
          }
          const lineage = results[3]?.results;
          if (topIds.length !== Math.min(generic.scans.total, 3) || !lineage || lineage.length > 1)
            return stamp(generic, actor, found, originalScope);
          // A listed scan must be one the read evaluated and one of the newest now: an undone or
          // replaced scan drops out of the newest three. A moved pass shows no scan at all.
          const listed = new Set(rows.map((row) => row.id));
          const verified = new Set(
            lineage.length === 1 ? topIds.filter((id) => listed.has(id)) : [],
          );
          const today = boundaries(now, scopeSnapshot.timeZone).today;
          const allVisible =
            complete &&
            lineage.length === 1 &&
            generic.scans.total === rows.length &&
            generic.scans.today === rows.filter((row) => row.at >= today).length &&
            verified.size === topIds.length;
          return stamp(
            render(rows, topIds, verified, generic, allVisible, now, scopeSnapshot.timeZone),
            actor,
            found,
            originalScope,
          );
        },
      };
    },
  };
}
