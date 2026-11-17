import type { ScanDisplayNeeds } from '../../../passkit/template/scan-display/index.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import {
  type DecodedPage,
  type DisplayHistoryRaw,
  type DisplayReadScope,
  decodeDisplayPage,
} from './history-display-read.ts';
import { captureDisplayHistoryScope, sameDisplayHistoryScope } from './history-display-scope.ts';
import type { PlannedDisplayScan } from './history-planned-display.ts';
import { createHistoryEvidenceCache, type HistoryEvidenceCache } from './history-row-evidence.ts';
import { validCredentialKeysetCommitment } from './repo-credential-tombstones.ts';
import {
  DISPLAY_PAGE_SIZE,
  displayHistoryPageStmt,
  displayHistoryScopeCountStmt,
  type PassScope,
} from './repo-scan-display-history.ts';
import type { Found } from './resolve.ts';
import type { DisplayRow } from './scan-display-history-view.ts';

export { planHistoryProofSnapshotsForOrg } from './lookup-history-plan.ts';

type ReadResult = { success: true; results: unknown[] } | { success: false; results?: unknown[] };

const brand: unique symbol = Symbol('preloaded-display-history');
export interface PreloadedDisplayHistory {
  readonly [brand]: true;
}
interface PreloadState extends DecodedPage {
  actor: ScanActor;
  found: Found;
  capturedScope: readonly unknown[];
  capturedWithoutEvent: readonly unknown[];
  scope: PassScope;
  requested: boolean;
  total: number;
  cache: HistoryEvidenceCache;
  ctx: ServiceContext;
}
const preloads = new WeakMap<PreloadedDisplayHistory, PreloadState>();

const eventOf = (actor: ScanActor) => actor.event?.id ?? actor.scannerAssignment?.eventId ?? null;
const wanted = (needs: ScanDisplayNeeds) => needs.history.length > 0 || needs.ledger.length > 0;

function passScope(ctx: ServiceContext, actor: ScanActor, found: Found): PassScope {
  return {
    orgId: actor.orgId,
    mode: actor.mode,
    passId: found.pass.id,
    templateId: found.pass.templateId,
    eventId: eventOf(actor),
    credentialKeysetCommitment: found.credentialKeysetCommitment,
    until: ctx.clock.now(),
  };
}

const readScope = (scope: PassScope): DisplayReadScope => scope;

/**
 * Prepare a bounded first page of the pass's check-ins, or every page when an earlier count
 * supplies the capacity, for a caller's existing D1 batch. One page statement reads the scans,
 * their signed events and the pass state of one snapshot; nothing is proven again afterwards.
 */
export function planDisplayHistoryRead(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  needs: ScanDisplayNeeds,
  expectedCount?: number,
  eventId?: string | null,
): {
  stmts: D1PreparedStatement[];
  finish(results: readonly ReadResult[]): Promise<PreloadedDisplayHistory | null>;
} {
  const scope = passScope(ctx, actor, found);
  if (eventId !== undefined) scope.eventId = eventId;
  const capturedScope = captureDisplayHistoryScope(actor, found);
  const capturedWithoutEvent = captureDisplayHistoryScope({ ...actor, event: null }, found);
  const requested = wanted(needs);
  const valid =
    validCredentialKeysetCommitment(scope.credentialKeysetCommitment) &&
    (expectedCount === undefined || (Number.isSafeInteger(expectedCount) && expectedCount >= 0));
  const pageCount =
    expectedCount === undefined ? 1 : Math.max(1, Math.ceil(expectedCount / DISPLAY_PAGE_SIZE));
  const stmts: D1PreparedStatement[] = [];
  if (requested && valid)
    for (let page = 0; page < pageCount; page++)
      stmts.push(displayHistoryPageStmt(ctx.env.DB, scope, page * DISPLAY_PAGE_SIZE, scope.until));
  let consumed = false;
  return {
    stmts,
    async finish(results) {
      if (
        consumed ||
        results.length !== stmts.length ||
        (requested && !valid) ||
        !sameDisplayHistoryScope(capturedScope, captureDisplayHistoryScope(actor, found))
      )
        return null;
      consumed = true;
      const cache = createHistoryEvidenceCache();
      const ids: string[] = [];
      const seen = new Set<string>();
      const rows = new Map<string, DisplayRow>();
      let total = 0;
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (!result?.results || result.success === false) return null;
        const page = await decodeDisplayPage(
          ctx,
          result.results as unknown as DisplayHistoryRaw[],
          readScope(scope),
          actor.role,
          cache,
        );
        const counted = (result.results as DisplayHistoryRaw[])[0]?.candidate_total;
        if (index === 0 && result.results.length) {
          if (typeof counted !== 'number' || !Number.isSafeInteger(counted)) return null;
          total = counted;
        }
        if (
          !page ||
          result.results.length !==
            Math.min(DISPLAY_PAGE_SIZE, Math.max(0, total - index * DISPLAY_PAGE_SIZE)) ||
          (result.results.length && counted !== total) ||
          page.ids.some((id) => seen.has(id))
        )
          return null;
        for (const id of page.ids) seen.add(id);
        ids.push(...page.ids);
        for (const [id, row] of page.rows) rows.set(id, row);
      }
      if (expectedCount !== undefined && total > pageCount * DISPLAY_PAGE_SIZE) return null;
      const token = Object.freeze({ [brand]: true as const });
      preloads.set(token, {
        actor,
        found,
        capturedScope,
        capturedWithoutEvent,
        scope,
        requested,
        total,
        ids,
        rows,
        cache,
        ctx,
      });
      return token;
    },
  };
}

/** Permit the evaluated event actor only when all non-event authority and pass scope is unchanged. */
export function rebindDisplayHistoryRead(
  preload: PreloadedDisplayHistory,
  actor: ScanActor,
  found: Found,
): boolean {
  const state = preloads.get(preload);
  if (
    !state ||
    eventOf(actor) !== state.scope.eventId ||
    !sameDisplayHistoryScope(
      state.capturedWithoutEvent,
      captureDisplayHistoryScope({ ...actor, event: null }, found),
    )
  )
    return false;
  state.actor = actor;
  state.found = found;
  state.capturedScope = captureDisplayHistoryScope(actor, found);
  return true;
}

/** Add the scan this request is about to commit; the final batch counts it with the rest. */
export function appendPlannedDisplayHistory(
  preload: PreloadedDisplayHistory,
  planned: PlannedDisplayScan,
): boolean {
  const state = preloads.get(preload);
  if (
    !state?.requested ||
    state.ids.length !== state.total ||
    planned.credentialKeysetCommitment !== state.scope.credentialKeysetCommitment ||
    planned.orgId !== state.scope.orgId ||
    planned.mode !== state.scope.mode ||
    planned.passId !== state.scope.passId ||
    planned.templateId !== state.scope.templateId ||
    (state.scope.eventId !== null && planned.eventId !== state.scope.eventId) ||
    state.ids.includes(planned.id)
  )
    return false;
  state.ids.push(planned.id);
  if (planned.row) state.rows.set(planned.id, planned.row);
  state.total++;
  return true;
}

/** Finish any remaining bounded pages together, then consume the opaque preload exactly once. */
export async function consumeDisplayHistoryRead(
  preload: PreloadedDisplayHistory,
  actor: ScanActor,
  found: Found,
  needs: ScanDisplayNeeds,
): Promise<(DecodedPage & { total: number; until: number }) | null> {
  const state = preloads.get(preload);
  if (
    !state ||
    state.actor !== actor ||
    state.found !== found ||
    state.requested !== wanted(needs) ||
    eventOf(actor) !== state.scope.eventId ||
    !sameDisplayHistoryScope(state.capturedScope, captureDisplayHistoryScope(actor, found))
  )
    return null;
  preloads.delete(preload);
  const { ctx, scope, total, ids, rows, cache } = state;
  const seen = new Set(ids);
  if (ids.length < total) {
    const db = ctx.env.DB;
    const stmts: D1PreparedStatement[] = [];
    for (let offset = ids.length; offset < total; offset += DISPLAY_PAGE_SIZE)
      stmts.push(displayHistoryPageStmt(db, scope, offset, scope.until));
    stmts.push(displayHistoryScopeCountStmt(db, scope));
    const results: ReadResult[] = await db.batch(stmts);
    const sentinel = results[results.length - 1];
    const sentinelRow = sentinel?.results?.[0];
    const count =
      sentinelRow !== null && typeof sentinelRow === 'object' && 'n' in sentinelRow
        ? sentinelRow.n
        : undefined;
    if (
      results.length !== stmts.length ||
      sentinel?.success === false ||
      sentinel?.results?.length !== 1 ||
      count !== total
    )
      return null;
    for (let index = 0; index < results.length - 1; index++) {
      const result = results[index];
      if (
        !result?.results ||
        result.success === false ||
        result.results.length !== Math.min(DISPLAY_PAGE_SIZE, total - ids.length)
      )
        return null;
      const page = await decodeDisplayPage(
        ctx,
        result.results as unknown as DisplayHistoryRaw[],
        readScope(scope),
        actor.role,
        cache,
      );
      if (!page || page.ids.some((id) => seen.has(id))) return null;
      for (const id of page.ids) seen.add(id);
      ids.push(...page.ids);
      for (const [id, row] of page.rows) rows.set(id, row);
    }
  }
  if (
    ids.length !== total ||
    !sameDisplayHistoryScope(state.capturedScope, captureDisplayHistoryScope(actor, found))
  )
    return null;
  return { ids, rows, total, until: scope.until };
}
