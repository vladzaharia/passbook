import type { ScanDisplayNeeds } from '../../../passkit/template/scan-display/index.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { credentialKeysetContext } from './credential-keyset-authority.ts';
import { captureDisplayHistoryScope, sameDisplayHistoryScope } from './history-display-scope.ts';
import { historyProofPolicySources, type VerifiedHistoryProof } from './history-proof.ts';
import {
  countStmt,
  type DecodedPage,
  decodePage,
  type HistoryOrgScope,
  type PassScope,
  pageStmt,
  passScope,
} from './history-proof-plan-query.ts';
import { validCredentialKeysetCommitment } from './repo-credential-tombstones.ts';
import { type HistoryProofRow, historyProofRowsStmt } from './repo-history-proof-read.ts';
import type { Found } from './resolve.ts';
import type { ScanEventProofCache } from './scan-event-proof.ts';

type ProofBatchResult =
  | { success: true; results: unknown[] }
  | { success: false; results?: unknown[] };

const PAGE_SIZE = 100;

/** Prepare independent scoped ID batches for inclusion in a caller's existing D1 batch. */
export function planHistoryProofSnapshotsForOrg(
  ctx: ServiceContext,
  scope: HistoryOrgScope,
  scanIds: readonly string[],
): {
  stmts: D1PreparedStatement[];
  finish(results: readonly ProofBatchResult[]): Promise<Map<string, VerifiedHistoryProof>>;
} {
  const operation = credentialKeysetContext(ctx);
  const captured = { ...scope };
  const ids = [...new Set(scanIds)];
  const requested = new Set(ids);
  const stmts: D1PreparedStatement[] = [];
  if (validCredentialKeysetCommitment(captured.credentialKeysetCommitment)) {
    for (let at = 0; at < ids.length; at += 96)
      stmts.push(
        historyProofRowsStmt(
          operation,
          { ids: ids.slice(at, at + 96) },
          's.org_id=? AND s.mode=?',
          [captured.orgId, captured.mode],
          captured.credentialKeysetCommitment,
        ),
      );
  }
  let consumed = false;
  return {
    stmts,
    async finish(results) {
      if (consumed || results.length !== stmts.length) return new Map();
      consumed = true;
      const proofs = new Map<string, VerifiedHistoryProof>();
      const seen = new Set<string>();
      const cache: ScanEventProofCache = new Map();
      for (const result of results) {
        if (!result.results || result.success === false) return new Map();
        const page = await decodePage(
          operation,
          result.results as unknown as HistoryProofRow[],
          captured,
          (row) => requested.has(row.id),
          cache,
        );
        if (!page || page.ids.some((id) => seen.has(id))) return new Map();
        for (const id of page.ids) seen.add(id);
        for (const [id, proof] of page.proofs) proofs.set(id, proof);
      }
      return proofs;
    },
  };
}

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
  cache: ScanEventProofCache;
  operation: ServiceContext;
}
const preloads = new WeakMap<PreloadedDisplayHistory, PreloadState>();

/** Prepare a bounded first proof page, or all pages when an earlier count supplies the capacity. */
export function planDisplayHistoryRead(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  needs: ScanDisplayNeeds,
  expectedCount?: number,
  eventId?: string | null,
): {
  stmts: D1PreparedStatement[];
  finish(results: readonly ProofBatchResult[]): Promise<PreloadedDisplayHistory | null>;
} {
  const operation = credentialKeysetContext(ctx);
  const scope = passScope(operation, actor, found);
  if (eventId !== undefined) scope.eventId = eventId;
  const capturedScope = captureDisplayHistoryScope(actor, found);
  const capturedWithoutEvent = captureDisplayHistoryScope({ ...actor, event: null }, found);
  const requested = needs.history.length > 0 || needs.ledger.length > 0;
  const valid =
    validCredentialKeysetCommitment(scope.credentialKeysetCommitment) &&
    (expectedCount === undefined || (Number.isSafeInteger(expectedCount) && expectedCount >= 0));
  const pageCount =
    expectedCount === undefined ? 1 : Math.max(1, Math.ceil(expectedCount / PAGE_SIZE));
  const stmts: D1PreparedStatement[] = [];
  if (requested && valid)
    for (let page = 0; page < pageCount; page++)
      stmts.push(pageStmt(operation, scope, page * PAGE_SIZE, page === 0));
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
      const cache: ScanEventProofCache = new Map();
      const ids: string[] = [];
      const seen = new Set<string>();
      const proofs = new Map<string, VerifiedHistoryProof>();
      let total = 0;
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (!result?.results || result.success === false) return null;
        const rows = result.results as unknown as (HistoryProofRow & {
          candidate_total?: number;
        })[];
        if (index === 0 && rows.length) {
          const count = rows[0]?.candidate_total;
          if (
            typeof count !== 'number' ||
            !Number.isSafeInteger(count) ||
            count < rows.length ||
            rows.some((row) => row.candidate_total !== count)
          )
            return null;
          total = count;
        }
        if (rows.length !== Math.min(PAGE_SIZE, Math.max(0, total - index * PAGE_SIZE)))
          return null;
        const page = await decodePage(
          operation,
          rows,
          scope,
          (row) =>
            row.pass_id === scope.passId &&
            row.template_id === scope.templateId &&
            (scope.eventId === null || row.event_id === scope.eventId),
          cache,
        );
        if (!page || page.ids.some((id) => seen.has(id))) return null;
        for (const id of page.ids) seen.add(id);
        ids.push(...page.ids);
        for (const [id, proof] of page.proofs) proofs.set(id, proof);
      }
      if (expectedCount !== undefined && total > pageCount * PAGE_SIZE) return null;
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
        proofs,
        cache,
        operation,
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
    (actor.event?.id ?? actor.scannerAssignment?.eventId ?? null) !== state.scope.eventId ||
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

/** Add an independently preverified planned scan; final bind still checks all its CAS fragments. */
export function appendPlannedDisplayHistory(
  preload: PreloadedDisplayHistory,
  proof: VerifiedHistoryProof,
): boolean {
  const state = preloads.get(preload);
  const source = historyProofPolicySources(proof);
  if (
    !state?.requested ||
    state.ids.length !== state.total ||
    !source ||
    !proof.projectionCurrent ||
    proof.credentialKeysetCommitment !== state.scope.credentialKeysetCommitment ||
    source.scan.orgId !== state.scope.orgId ||
    source.scan.mode !== state.scope.mode ||
    source.scan.passId !== state.scope.passId ||
    source.scan.templateId !== state.scope.templateId ||
    (state.scope.eventId !== null && source.scan.eventId !== state.scope.eventId) ||
    state.ids.includes(proof.scan.id)
  )
    return false;
  state.ids.push(proof.scan.id);
  state.proofs.set(proof.scan.id, proof);
  state.total++;
  return true;
}

/** Finish any remaining bounded pages together, then consume the opaque preload exactly once. */
export async function consumeDisplayHistoryRead(
  preload: PreloadedDisplayHistory,
  actor: ScanActor,
  found: Found,
  needs: ScanDisplayNeeds,
): Promise<(DecodedPage & { total: number; until: number; cache: ScanEventProofCache }) | null> {
  const state = preloads.get(preload);
  if (
    !state ||
    state.actor !== actor ||
    state.found !== found ||
    state.requested !== (needs.history.length > 0 || needs.ledger.length > 0) ||
    (actor.event?.id ?? actor.scannerAssignment?.eventId ?? null) !== state.scope.eventId ||
    !sameDisplayHistoryScope(state.capturedScope, captureDisplayHistoryScope(actor, found))
  )
    return null;
  preloads.delete(preload);
  const { operation, scope, total, ids, proofs, cache } = state;
  const seen = new Set(ids);
  if (ids.length < total) {
    const stmts: D1PreparedStatement[] = [];
    for (let offset = ids.length; offset < total; offset += PAGE_SIZE)
      stmts.push(pageStmt(operation, scope, offset, false));
    stmts.push(countStmt(operation, scope));
    const results: ProofBatchResult[] = await operation.env.DB.batch(stmts);
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
        result.results.length !== Math.min(PAGE_SIZE, total - ids.length)
      )
        return null;
      const page = await decodePage(
        operation,
        result.results as unknown as HistoryProofRow[],
        scope,
        (row) =>
          row.pass_id === scope.passId &&
          row.template_id === scope.templateId &&
          (scope.eventId === null || row.event_id === scope.eventId),
        cache,
      );
      if (!page || page.ids.some((id) => seen.has(id))) return null;
      for (const id of page.ids) seen.add(id);
      ids.push(...page.ids);
      for (const [id, proof] of page.proofs) proofs.set(id, proof);
    }
  }
  if (
    ids.length !== total ||
    !sameDisplayHistoryScope(state.capturedScope, captureDisplayHistoryScope(actor, found))
  )
    return null;
  return { ids, proofs, total, until: scope.until, cache };
}
