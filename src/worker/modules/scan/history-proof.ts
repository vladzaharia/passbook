import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { SqlValue } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { EventRow } from '../events/repo.ts';
import type { ScanActor } from './actor.ts';
import { credentialKeysetContext } from './credential-keyset-authority.ts';
import {
  currentHistoryTitle,
  type HistoryManifest,
  type HistoryPolicyInput,
} from './history-policy.ts';
import { validCredentialKeysetCommitment } from './repo-credential-tombstones.ts';
import {
  captureHistoryProofSnapshot,
  type HistoryProofSnapshot,
} from './repo-history-proof-cas.ts';
import { type HistoryProofRow, historyProofRowsStmt } from './repo-history-proof-read.ts';
import { toScan } from './repo-scan-map.ts';
import {
  type ScanEventProofCache,
  type ScanEventReference,
  verifyScanEventProvenance,
} from './scan-event-proof.ts';

/** Minimal serializable evidence; policy sources are request-local and never part of a proof. */
export interface VerifiedHistoryProof {
  scan: { id: string; eventId: string | null };
  credentialKeysetCommitment: string;
  projectionCurrent: boolean;
  snapshot: HistoryProofSnapshot;
}

/** Sensitive inputs needed only while evaluating a verified proof's history policy. */
export interface HistoryProofPolicySources extends Omit<HistoryPolicyInput, 'role' | 'proofCache'> {
  scan: ScanEventReference & { undoneBy: string | null };
  eventWallet: HistoryManifest | null;
  currentTitle: string | null;
  currentScannerName: string | null;
  privateValues: readonly string[];
  amount: number | null;
  before: string | null;
  after: string | null;
}

const policySources = new WeakMap<VerifiedHistoryProof, HistoryProofPolicySources>();

/** Unknown or copied proofs cannot recover request-local policy sources. */
export function historyProofPolicySources(
  proof: VerifiedHistoryProof,
): HistoryProofPolicySources | null {
  return policySources.get(proof) ?? null;
}

function manifest(version: string | null, raw: string | null): HistoryManifest | null {
  if (!version || !raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return { version, manifest: value as TemplateManifest };
  } catch {
    return null;
  }
}

function privateValues(row: HistoryProofRow): string[] | null {
  if (!row.current_wallet_private_values) return null;
  try {
    const values = [
      row.pass_serial,
      row.pass_auth_token,
      row.pass_download_token,
      row.pass_web_service_url,
      row.pass_scan_code,
      row.pass_external_id,
      row.pass_holder_email,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && value.length > 0) values.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
    };
    collect(JSON.parse(row.current_wallet_private_values));
    return values;
  } catch {
    return null;
  }
}

export async function verifyHistoryProofRow(
  ctx: ServiceContext,
  row: HistoryProofRow,
  credentialKeysetCommitment: string,
  proofCache?: ScanEventProofCache,
): Promise<VerifiedHistoryProof | null> {
  if (
    !row.ledger_id ||
    !row.ledger_org_id ||
    !row.ledger_pass_id ||
    !row.ledger_mode ||
    !row.ledger_kind ||
    row.ledger_data === null ||
    row.ledger_at === null ||
    !row.recorded_template_version ||
    typeof row.recorded_wallet_version !== 'number' ||
    (row.approved_proof !== 1 && row.legacy_proof !== 1)
  )
    return null;
  const event: EventRow = {
    id: row.ledger_id,
    org_id: row.ledger_org_id,
    pass_id: row.ledger_pass_id,
    mode: row.ledger_mode,
    kind: row.ledger_kind,
    device: row.ledger_device,
    actor_type: row.ledger_actor_type,
    actor_id: row.ledger_actor_id,
    data: row.ledger_data,
    at: row.ledger_at,
  };
  const scan: ScanEventReference & { undoneBy: string | null } = {
    ...toScan(row),
    pinnedTemplateVersion: row.recorded_template_version,
    walletVersion: row.recorded_wallet_version,
    walletTemplateVersion: row.recorded_wallet_template_version,
    direction: row.direction,
    presenceScope: row.presence_scope,
  };
  if (!(await verifyScanEventProvenance(ctx.env, event, scan, proofCache))) return null;
  const secrets = privateValues(row);
  const snapshot = captureHistoryProofSnapshot(row, credentialKeysetCommitment);
  if (!snapshot) return null;
  const currentPinned = manifest(row.current_pinned_version, row.current_pinned_manifest);
  const proof: VerifiedHistoryProof = Object.freeze({
    scan: Object.freeze({ id: scan.id, eventId: scan.eventId }),
    credentialKeysetCommitment,
    projectionCurrent:
      row.projection_current === 1 &&
      secrets !== null &&
      typeof row.current_lifecycle_generation === 'number' &&
      Number.isSafeInteger(row.current_lifecycle_generation) &&
      row.current_lifecycle_generation >= 0,
    snapshot,
  });
  Object.freeze(event);
  Object.freeze(scan);
  if (secrets !== null)
    policySources.set(
      proof,
      Object.freeze({
        event,
        scan,
        credentialKeysetCommitment,
        currentPersonalization: row.current_personalization,
        versionPersonalization: row.recorded_personalization,
        currentCredentialGeneration: row.current_credential_generation,
        transferPending: row.current_transfer_pending !== 0,
        eventPinned: manifest(row.recorded_template_version, row.event_pinned_manifest),
        eventWallet: manifest(row.recorded_wallet_template_version, row.event_wallet_manifest),
        eventActive: manifest(row.event_active_version, row.event_active_manifest),
        currentPinned,
        currentActive: manifest(row.current_active_version, row.current_active_manifest),
        currentTitle: currentHistoryTitle(currentPinned, row.current_personalization),
        currentScannerName: row.current_scanner_name,
        privateValues: Object.freeze(secrets),
        amount: row.amount,
        before: row.before_value,
        after: row.after_value,
      }),
    );
  return proof;
}

async function scopedHistoryProofSnapshots(
  ctx: ServiceContext,
  ids: readonly string[],
  cache: Map<string, VerifiedHistoryProof | null>,
  scopeSql: string,
  scopeParams: SqlValue[],
  credentialKeysetCommitment: string | null | undefined,
  proofCache?: ScanEventProofCache,
): Promise<Map<string, VerifiedHistoryProof>> {
  if (!validCredentialKeysetCommitment(credentialKeysetCommitment) || !ids.length) return new Map();
  const requested = [...ids];
  const scopeValues = [...scopeParams];
  const prefix = [scopeSql, ...scopeValues, credentialKeysetCommitment]
    .map((value) => {
      const text = String(value);
      return `${typeof value}:${text.length}:${text}`;
    })
    .join('');
  const keys = new Map(
    await Promise.all(
      [...new Set(requested)].map(
        async (id) => [id, await sha256Hex(`${prefix}string:${id.length}:${id}`)] as const,
      ),
    ),
  );
  const missing = [...keys].filter(([, key]) => !cache.has(key)).map(([id]) => id);
  const batchSize = Math.max(1, 98 - scopeValues.length);
  for (let start = 0; start < missing.length; start += batchSize) {
    const batch = missing.slice(start, start + batchSize);
    const rows = (
      await historyProofRowsStmt(
        ctx,
        { ids: batch },
        scopeSql,
        scopeValues,
        credentialKeysetCommitment,
      ).all<HistoryProofRow>()
    ).results;
    const byId = new Map(rows.map((row) => [row.id, row]));
    await Promise.all(
      batch.map(async (id) => {
        const row = byId.get(id);
        const key = keys.get(id);
        if (key === undefined) throw new Error('Missing history proof cache key.');
        cache.set(
          key,
          row
            ? await verifyHistoryProofRow(ctx, row, credentialKeysetCommitment, proofCache)
            : null,
        );
      }),
    );
  }
  const result = new Map<string, VerifiedHistoryProof>();
  for (const id of requested) {
    const key = keys.get(id);
    if (key === undefined) throw new Error('Missing history proof cache key.');
    const proof = cache.get(key);
    if (proof) result.set(id, proof);
  }
  return result;
}

/** Actor-owned, bounded verified snapshots. Cache is scoped to this request. */
export function historyProofSnapshots(
  ctx: ServiceContext,
  actor: ScanActor,
  ids: readonly string[],
  cache: Map<string, VerifiedHistoryProof | null>,
  proofCache?: ScanEventProofCache,
): Promise<Map<string, VerifiedHistoryProof>> {
  return scopedHistoryProofSnapshots(
    credentialKeysetContext(ctx),
    ids,
    cache,
    's.actor_key=?/* scan-ephemeral-actor-key */ AND s.org_id=? AND s.mode=?',
    [actor.actorKey, actor.orgId, actor.mode],
    actor.credentialKeysetCommitment,
    proofCache,
  );
}

/** Tenant-scoped proof batches; callers must independently fence tenant/session authority. */
export function historyProofSnapshotsForOrg(
  ctx: ServiceContext,
  scope: { orgId: string; mode: Mode; credentialKeysetCommitment: string },
  ids: readonly string[],
  cache: Map<string, VerifiedHistoryProof | null>,
  proofCache?: ScanEventProofCache,
): Promise<Map<string, VerifiedHistoryProof>> {
  return scopedHistoryProofSnapshots(
    credentialKeysetContext(ctx),
    ids,
    cache,
    's.org_id=? AND s.mode=?',
    [scope.orgId, scope.mode],
    scope.credentialKeysetCommitment,
    proofCache,
  );
}

/** Cross-organization batches are restricted to the exact caller-supplied tenant/mode/id tuples. */
export async function historyProofSnapshotsForScopes(
  ctx: ServiceContext,
  scopes: readonly { orgId: string; mode: Mode; scanId: string }[],
  cache: Map<string, VerifiedHistoryProof | null>,
  credentialKeysetCommitment: string,
  proofCache?: ScanEventProofCache,
): Promise<Map<string, VerifiedHistoryProof>> {
  const captured = scopes.map(({ orgId, mode, scanId }) => ({ orgId, mode, scanId }));
  const operation = credentialKeysetContext(ctx);
  const result = new Map<string, VerifiedHistoryProof>();
  for (let at = 0; at < captured.length; at += 20) {
    const page = captured.slice(at, at + 20);
    const scopeSql = page
      .map(() => '(s.org_id=? AND s.mode=? AND s.id=?/* scan-ephemeral-scan-id */)')
      .join(' OR ');
    const scopeParams = page.flatMap((entry) => [entry.orgId, entry.mode, entry.scanId]);
    const proofs = await scopedHistoryProofSnapshots(
      operation,
      page.map((entry) => entry.scanId),
      cache,
      `(${scopeSql})`,
      scopeParams,
      credentialKeysetCommitment,
      proofCache,
    );
    for (const [id, proof] of proofs) result.set(id, proof);
  }
  return result;
}
