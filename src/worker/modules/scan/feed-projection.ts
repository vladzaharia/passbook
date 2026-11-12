import type { z } from 'zod';
import {
  type ScanFeedRowSchema,
  ScanReasonSchema,
  type ScanRecordDto,
  ScanRecordKindSchema,
} from '../../../shared/contracts/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import {
  ConflictError,
  ForbiddenError,
  UnauthenticatedError,
  UnavailableError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import { actorCsrfFence } from './actor-csrf.ts';
import { historyOf, projectScanRecord } from './feed-projection-history.ts';
import type { ScanActor } from './guard.ts';
import type { HistoryPolicy } from './history-policy.ts';
import {
  historyProofPolicySources,
  historyProofSnapshotsForOrg,
  type VerifiedHistoryProof,
} from './history-proof.ts';
import { getScanRowsByIds, type ScanLogFilter, type ScanLogRow } from './repo-feed.ts';
import {
  consoleFeedAuthoritySql,
  consoleFeedBoundaryPredicate,
  consoleFeedFencePredicates,
  consoleFeedRecordPredicates,
} from './repo-feed-projection.ts';
import { outputPredicatesCurrent } from './repo-output-predicates.ts';
import type { ScanEventProofCache } from './scan-event-proof.ts';
import { recordedRoleProjected } from './scan-event-proof-recorded.ts';
import type { PasslessScan } from './scan-passless.ts';

export type ConsoleAuthority = Extract<TenantPassWrite, { kind: 'session' }>;

const HISTORY_BATCH = 32;

export type Feed = z.infer<typeof ScanFeedRowSchema>;

function feedJson(raw: string | null): Feed['before'] {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Feed['before'];
  } catch {
    return raw;
  }
}

/** The verified event proof signs which roles may see the action; a key may see what the door may. */
function doorSeesAction(row: ScanLogRow): boolean {
  try {
    const data: unknown = JSON.parse(row.eventProof?.event.data ?? 'null');
    const door = (
      data as { authority?: { eventProjection?: { roles?: { door?: unknown } } } } | null
    )?.authority?.eventProjection?.roles?.door as { action?: unknown } | undefined;
    return !!door && typeof door.action === 'object' && door.action !== null;
  } catch {
    // A proof whose data cannot be read grants no action detail.
    return false;
  }
}

/** As the console: a pass shows only when the event projected its recorded role. */
function passProjected(row: ScanLogRow): boolean {
  try {
    const data: unknown = JSON.parse(row.eventProof?.event.data ?? 'null');
    return recordedRoleProjected((data as { authority?: unknown } | null)?.authority);
  } catch {
    // A proof whose data cannot be read projects no pass.
    return false;
  }
}

/** API keys have no scan role: names stay out, and action detail follows the door's event-time view. */
export function toFeed(row: ScanLogRow): Feed {
  const reason = ScanReasonSchema.safeParse(row.reason);
  const noPolicy = !row.policyAvailable;
  const passHidden = noPolicy || (row.passId !== null && !passProjected(row));
  const detail = !passHidden && doorSeesAction(row);
  const kind = detail ? ScanRecordKindSchema.safeParse(row.actionKind) : null;
  return {
    id: row.id,
    at: row.at,
    passId: passHidden ? null : row.passId,
    externalId: null,
    templateId: passHidden ? null : row.templateId,
    eventId: !noPolicy || row.passlessProofCandidate ? row.eventId : null,
    actionId: detail ? row.actionId : null,
    kind: kind?.success ? kind.data : null,
    outcome: row.outcome ?? 'refused',
    reason: reason.success ? reason.data : null,
    amount: detail ? row.amount : null,
    before: detail ? feedJson(row.before) : null,
    after: detail ? feedJson(row.after) : null,
    method: row.method === 'auto' ? 'manual' : row.method,
    scannerId: noPolicy ? null : row.scannerId,
    scannerName: null,
    undoneAt: row.undoneAt,
  };
}

export function assertFeedKey(status: 'ok' | 'invalid' | 'forbidden'): void {
  if (status === 'invalid')
    throw new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
  if (status === 'forbidden')
    throw new ForbiddenError('The API key lacks the scans:read scope.', 'MISSING_SCOPE');
}

/**
 * Event, scanner and staff filters also run in SQL, which narrows the candidates. Only a projected
 * record whose provenance was verified may match them, and pass IDs and titles match here alone.
 */
export function recordMatches(record: ScanRecordDto, filter: ScanLogFilter): boolean {
  return (
    (!filter.passId || record.passId === filter.passId) &&
    (!filter.eventId || record.eventId === filter.eventId) &&
    (!filter.scannerId || record.scannerId === filter.scannerId) &&
    (!filter.staffId || record.staffId === filter.staffId) &&
    (!filter.q ||
      record.passId === filter.q ||
      !!record.passTitle?.toLowerCase().startsWith(filter.q.toLowerCase()))
  );
}

/** The viewer's tenant grants, not the scanner that recorded a row, determine visibility. */
export async function consoleFeedActor(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: ConsoleAuthority,
): Promise<ScanActor> {
  const actor = adminActor(session, authority.mode, {
    orgId: authority.orgId,
    event: null,
    templateIds: [],
    timeZone: 'UTC',
  });
  actor.tenantAuthority = await captureScanTenantAuthority(ctx, session, authority);
  actor.platformSessionId = session.sessionId;
  actor.role = tenantScanRole(authority);
  return actor;
}
/** This predicate is bound directly, never packed into output JSON, because it contains the session secret. */
export async function consoleFeedAuthorityPredicate(ctx: ServiceContext, actor: ScanActor) {
  const csrf = await actorCsrfFence(ctx, actor);
  return consoleFeedAuthoritySql(ctx, actor, csrf);
}

export interface ProjectedRecord {
  record: ScanRecordDto;
  snapshot: {
    actor: ScanActor;
    row: ScanLogRow;
    proof: VerifiedHistoryProof | null;
    passless: PasslessScan | null;
  };
}

/** Recheck every ledger row and viewer, plus any projected pass, in one transaction snapshot. */
export async function fenceRecords(
  ctx: ServiceContext,
  credentialKeysetCommitment: string,
  records: readonly ProjectedRecord[],
  requestActor: ScanActor,
  boundary?: { row: ScanLogRow; filter: ScanLogFilter; now: number },
): Promise<ProjectedRecord[]> {
  const check = async (items: readonly ProjectedRecord[]) => {
    const now = ctx.clock.now();
    const requestAuthority = await consoleFeedAuthorityPredicate(ctx, requestActor);
    const boundaryCheck = consoleFeedBoundaryPredicate(boundary);
    const predicates = consoleFeedRecordPredicates(items, now, credentialKeysetCommitment);
    const [authorityCurrent, keysetCurrent, boundaryCurrent, ...current] =
      await outputPredicatesCurrent(
        ctx.env.DB,
        consoleFeedFencePredicates(
          requestAuthority,
          credentialKeysetCommitment,
          boundaryCheck,
          predicates,
        ),
      );
    if (!keysetCurrent)
      throw new UnavailableError(
        'Credential references are unavailable.',
        'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      );
    if (!authorityCurrent) throw new ForbiddenError();
    if (!boundaryCurrent)
      throw new ConflictError('Scan history changed. Reload and retry.', 'SCAN_HISTORY_CHANGED');
    let offset = 0;
    return predicates.map((group) => {
      const start = offset;
      offset += group.length;
      return group.every((_, index) => current[start + index] === true);
    });
  };
  const current = await check(records);
  const stale = records.filter(
    (item, index) =>
      current[index] !== true &&
      item.snapshot.row.policyAvailable &&
      (item.snapshot.row.passId !== null || item.snapshot.passless !== null),
  );
  const firstStale = stale[0];
  if (!firstStale) return records.filter((_, index) => current[index] === true);
  // An eligible ledger row can outlive its policy. Re-read failed projections together and
  // re-fence the entire response, retaining only fresh, minimal history for those rows.
  const actor = firstStale.snapshot.actor;
  const fresh = await getScanRowsByIds(
    ctx.env.DB,
    stale.map((item) => item.snapshot.row.id),
    ctx.clock.now(),
    actor.mode,
    actor.orgId,
  );
  const byId = new Map(fresh.map((row) => [row.id, row]));
  const recovered = records.flatMap((item, index): ProjectedRecord[] => {
    if (current[index] === true) return [item];
    if (
      !item.snapshot.row.policyAvailable ||
      (item.snapshot.row.passId === null && !item.snapshot.passless)
    )
      return [];
    const row = byId.get(item.snapshot.row.id);
    if (!row || row.at !== item.snapshot.row.at) return [];
    const minimal = { ...row, policyAvailable: false, eventProof: null, keySnapshot: null };
    return [
      {
        record: projectScanRecord(minimal, null, item.snapshot.actor, null),
        snapshot: { actor: item.snapshot.actor, row: minimal, proof: null, passless: null },
      },
    ];
  });
  const refenced = await check(recovered);
  return recovered.filter((_, index) => refenced[index] === true);
}

/** Build console projections from bounded SQL-only history snapshots. */
export async function recordsOf(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: ConsoleAuthority,
  credentialKeysetCommitment: string,
  rows: readonly ScanLogRow[],
  proofCache: ScanEventProofCache = new Map(),
  passlessProofs: ReadonlyMap<string, PasslessScan> = new Map(),
  capturedActor?: ScanActor,
) {
  const actor = capturedActor ?? (await consoleFeedActor(ctx, session, authority));
  if (!capturedActor) actor.credentialKeysetCommitment = credentialKeysetCommitment;
  const scoped = rows.filter((row) => row.orgId === authority.orgId && row.mode === authority.mode);
  const ids = scoped.filter((row) => row.policyAvailable && row.eventProof).map((row) => row.id);
  const proofs = ids.length
    ? await historyProofSnapshotsForOrg(
        ctx,
        { orgId: authority.orgId, mode: authority.mode, credentialKeysetCommitment },
        ids,
        new Map(),
        proofCache,
      )
    : new Map<string, VerifiedHistoryProof>();
  const histories: (HistoryPolicy | null)[] = new Array(scoped.length).fill(null);
  for (let start = 0; start < scoped.length; start += HISTORY_BATCH) {
    await Promise.all(
      scoped.slice(start, start + HISTORY_BATCH).map(async (row, index) => {
        const proof = proofs.get(row.id);
        if (proof) histories[start + index] = await historyOf(ctx, row, proof, actor, proofCache);
      }),
    );
  }
  return scoped.map((row, index): ProjectedRecord => {
    const history = histories[index] ?? null;
    const proof = history ? (proofs.get(row.id) ?? null) : null;
    return {
      record: projectScanRecord(
        row,
        proof ? (historyProofPolicySources(proof)?.currentTitle ?? null) : null,
        actor,
        history,
      ),
      snapshot: { actor, row, proof, passless: passlessProofs.get(row.id) ?? null },
    };
  });
}
