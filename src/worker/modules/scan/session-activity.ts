import type { ScanRole } from '../../../shared/contracts/scan.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import type { ScanActor } from './actor.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { historyProofSnapshotsForOrg } from './history-proof.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import { activityCredentialFenceStmt, activityReadPlan } from './repo-session-activity.ts';
import {
  activityProofFenceStmt,
  activityProofPredicates,
  activityScopedGuardPredicate,
  activityStandaloneStatusStmt,
} from './repo-session-activity-fences.ts';
import type { ScanEventProofCache } from './scan-event-proof.ts';
import { resolveSessionScope, type SessionCountAuthority } from './scanning-session-dto.ts';
import { scanSessionCountAuthority } from './scanning-workspace.ts';
import {
  captureObservedScanningSession,
  cloneObservedScanActor,
} from './scanning-workspace-observation.ts';
import {
  candidatesOf,
  prepareProjection,
  sameCandidate,
  unavailable,
} from './session-activity-projection.ts';

/** Verify the bounded page, then recheck every projection and the actor in one D1 snapshot. */
export async function scanningSessionActivity(
  context: ServiceContext,
  originalRow: ScanningSessionRow,
  input: SessionCountAuthority,
  role: ScanRole,
) {
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  const row = { ...originalRow };
  if (
    !input ||
    typeof input.guardAt !== 'function' ||
    !input.guard ||
    typeof input.guard.sql !== 'string' ||
    !Array.isArray(input.guard.params) ||
    input.orgId !== row.org_id ||
    input.mode !== row.mode ||
    (input.sessionId !== undefined && input.sessionId !== row.id) ||
    (role !== 'door' && role !== 'desk' && role !== 'manager')
  )
    return null;
  const capturedGuardAt = input.guardAt.bind(input);
  const captured: SessionCountAuthority = {
    ...input,
    guard: { sql: input.guard.sql, params: [...input.guard.params] },
    guardAt: capturedGuardAt,
  };
  const selected = await resolveSessionScope(ctx, row);
  if (!selected.valid) return null;
  // Scanner, session and event configuration are epoch comparisons in the guard.
  const confirmed = await resolveSessionScope(ctx, row);
  if (!confirmed.valid || canonicalJson(selected) !== canonicalJson(confirmed)) return null;
  const guardAt = (now: number) => {
    const guard = captured.guardAt(now);
    return guard ? activityScopedGuardPredicate(guard, { sql: '1', params: [] }) : null;
  };
  const guard = guardAt(ctx.clock.now());
  if (!guard) return null;
  const authority: SessionCountAuthority = { ...captured, guard, guardAt };
  const initial = activityReadPlan(ctx.env.DB, row, authority, ctx.clock.now());
  if (!initial) return null;
  const proofCache: ScanEventProofCache = new Map();
  const reads = await ctx.env.DB.batch([initial]);
  const candidates = candidatesOf(reads[0]);
  if (candidates === null) return null;
  const ids = candidates.flatMap((candidate) => (candidate.passId ? [candidate.id] : []));
  const proofs = await historyProofSnapshotsForOrg(
    ctx,
    {
      orgId: row.org_id,
      mode: row.mode,
      credentialKeysetCommitment: authority.credentialKeysetCommitment,
    },
    ids,
    new Map(),
    proofCache,
  );
  const projections = await Promise.all(
    candidates.map((candidate) =>
      prepareProjection(ctx, row, role, candidate, proofs.get(candidate.id), proofCache),
    ),
  );
  const now = ctx.clock.now();
  const final = activityReadPlan(ctx.env.DB, row, authority, now);
  if (!final) return null;
  const statements: D1PreparedStatement[] = [final];
  const groups: { id: string; start: number; end: number }[] = [];
  for (const projection of projections) {
    if (!projection) continue;
    const predicates = activityProofPredicates(projection.proof, now);
    if (!predicates.length || predicates.some((predicate) => predicate.sql === '0')) continue;
    const start = statements.length;
    for (const predicate of predicates)
      statements.push(activityProofFenceStmt(ctx.env.DB, row, projection.candidate.id, predicate));
    statements.push(
      activityCredentialFenceStmt(ctx.env.DB, row, projection.candidate, projection.refs),
    );
    groups.push({ id: projection.candidate.id, start, end: statements.length });
  }
  const results = await ctx.env.DB.batch(statements);
  if (
    results.length !== statements.length ||
    results.some((result) => !Array.isArray(result?.results))
  )
    throw unavailable();
  const current = candidatesOf(results[0]);
  if (current === null) return null;
  const byId = new Map(current.map((candidate) => [candidate.id, candidate]));
  const proven = new Set(
    groups
      .filter(
        ({ id, start, end }) =>
          results.slice(start, end).length === end - start &&
          results.slice(start, end).every((result) => {
            const value = result?.results?.[0];
            return (
              result?.results?.length === 1 &&
              value !== null &&
              typeof value === 'object' &&
              'id' in value &&
              value.id === id
            );
          }),
      )
      .map(({ id }) => id),
  );
  return candidates.flatMap((candidate, index) => {
    const latest = byId.get(candidate.id);
    if (!latest || !sameCandidate(candidate, latest)) return [];
    const projection = projections[index];
    const safe = !!projection && proven.has(candidate.id);
    return [
      {
        id: candidate.id,
        at: candidate.at,
        deviceId: candidate.deviceId,
        deviceName:
          safe && projection.policy.scannerNameVisible(candidate.deviceName)
            ? candidate.deviceName
            : 'Scanner',
        passId: safe ? candidate.passId : null,
        title: safe && projection.policy.titleVisible(projection.title) ? projection.title : null,
        outcome: candidate.outcome,
        direction: safe && projection.directionAllowed ? candidate.direction : null,
      },
    ];
  });
}
/** Device activity keeps the original actor, session and CSRF snapshot through the final read. */
export async function sessionActivityFor(context: ServiceContext, sourceActor: ScanActor) {
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  const actor = cloneObservedScanActor(sourceActor);
  const observed = actor.scanningSession ? captureObservedScanningSession(actor) : null;
  if (!actor.role || actor.invalidScannerScope || (actor.scanningSession && !observed))
    throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  const base = await scanSessionCountAuthority(ctx, actor);
  const guard = base.guardAt(ctx.clock.now());
  if (!guard)
    throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  if (!observed) {
    if (guard.params.length >= 99) throw unavailable();
    const [result] = await ctx.env.DB.batch([activityStandaloneStatusStmt(ctx.env.DB, guard)]);
    const status = result?.results?.[0];
    if (
      !status ||
      typeof status !== 'object' ||
      !('authorized' in status) ||
      status.authorized !== 1
    )
      throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
    return { items: [] };
  }
  if (!observed.scope)
    throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  const rows = await scanningSessionActivity(ctx, observed.parent, base, actor.role);
  if (rows === null)
    throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  return {
    items: rows.filter((row) => actor.settings.lookup || row.deviceId === actor.scanner?.id),
  };
}
