import { all, chunk, first, placeholders } from '../../platform/db.ts';

// Passes (sync bookkeeping only; content changes go through passes/service.ts)

export interface SyncPass {
  id: string;
  orgId: string;
  mode: 'live' | 'test';
  status: 'active' | 'voided';
  version: number;
  rowVersion: number;
  identityId: string;
  credentialGeneration: number;
  lifecycleGeneration: number;
  credentialKeysetCommitment: string;
  transferPending: boolean;
  ownerUserId: string | null;
  linkGeneration: number;
  deletedAt: number | null;
  removedAt: number | null;
  connectionId: string | null;
  externalRef: string | null;
  templateId: string;
  releaseId: string | null;
  templateVersion: string;
  personalization: Record<string, unknown>;
}

export type PassReleaseBinding = Pick<SyncPass, 'templateId' | 'templateVersion' | 'releaseId'>;

export function validPassReleaseBinding(p: PassReleaseBinding): boolean {
  return (
    typeof p.templateId === 'string' &&
    !!p.templateId &&
    typeof p.templateVersion === 'string' &&
    !!p.templateVersion &&
    (p.releaseId === null || (typeof p.releaseId === 'string' && !!p.releaseId))
  );
}

export function validCredentialKeysetCommitment(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

interface SyncPassSql {
  id: string;
  org_id: string;
  mode: 'live' | 'test';
  status: 'active' | 'voided';
  version: number;
  row_version: number;
  identity_id: unknown;
  credential_generation: unknown;
  lifecycle_generation: unknown;
  credential_keyset_commitment: unknown;
  transfer_pending: unknown;
  owner_user_id: string | null;
  link_generation: number;
  deleted_at: number | null;
  removed_at: number | null;
  connection_id: string | null;
  external_ref: string | null;
  template_id: string;
  release_id: string | null;
  template_version: string;
  personalization: string;
}

const PASS_COLUMNS = `id, org_id, mode, status, version, row_version, identity_id, credential_generation, lifecycle_generation,
  EXISTS (SELECT 1 FROM pass_credential_transfers pct
    WHERE pct.pass_id = passes.id AND pct.state = 'pending') AS transfer_pending,
  (SELECT commitment FROM credential_ref_keyset WHERE id = 1) AS credential_keyset_commitment,
  owner_user_id, link_generation, deleted_at, removed_at, connection_id, external_ref,
  template_id, template_version, release_id, personalization`;

function toPass(r: SyncPassSql): SyncPass | null {
  if (
    typeof r.identity_id !== 'string' ||
    !r.identity_id ||
    typeof r.credential_generation !== 'number' ||
    !Number.isSafeInteger(r.credential_generation) ||
    r.credential_generation < 1 ||
    typeof r.lifecycle_generation !== 'number' ||
    !Number.isSafeInteger(r.lifecycle_generation) ||
    r.lifecycle_generation < 0 ||
    !validCredentialKeysetCommitment(r.credential_keyset_commitment) ||
    (r.transfer_pending !== 0 && r.transfer_pending !== 1) ||
    !validPassReleaseBinding({
      templateId: r.template_id,
      templateVersion: r.template_version,
      releaseId: r.release_id,
    })
  )
    return null;
  return {
    id: r.id,
    orgId: r.org_id,
    mode: r.mode,
    status: r.status,
    version: r.version,
    rowVersion: r.row_version,
    identityId: r.identity_id,
    credentialGeneration: r.credential_generation,
    lifecycleGeneration: r.lifecycle_generation,
    credentialKeysetCommitment: r.credential_keyset_commitment,
    transferPending: r.transfer_pending === 1,
    ownerUserId: r.owner_user_id,
    linkGeneration: r.link_generation,
    deletedAt: r.deleted_at,
    removedAt: r.removed_at,
    connectionId: r.connection_id,
    externalRef: r.external_ref,
    templateId: r.template_id,
    releaseId: r.release_id,
    templateVersion: r.template_version,
    personalization: JSON.parse(r.personalization) as Record<string, unknown>,
  };
}

export async function getPassByRef(
  db: D1Database,
  orgId: string,
  connectionId: string,
  ref: string,
): Promise<SyncPass | null> {
  const r = await first<SyncPassSql>(
    db,
    `SELECT ${PASS_COLUMNS} FROM passes
     WHERE org_id = ? AND mode = 'live' AND connection_id = ? AND external_ref = ?
       AND status = 'active' AND deleted_at IS NULL AND removed_at IS NULL
       AND test_data_quarantined = 0 LIMIT 1`,
    [orgId, connectionId, ref],
  );
  return r ? toPass(r) : null;
}

/** A legacy ineligible binding still occupies the unique (org, connection, ref) key. */
export async function hasBinding(
  db: D1Database,
  orgId: string,
  connectionId: string,
  ref: string,
): Promise<boolean> {
  return (
    (await first(
      db,
      'SELECT 1 FROM passes WHERE org_id = ? AND connection_id = ? AND external_ref = ? LIMIT 1',
      [orgId, connectionId, ref],
    )) !== null
  );
}

/** Active passes linked to `refs`, keyed by ref. */
export async function listPassesByRefs(
  db: D1Database,
  orgId: string,
  connectionId: string,
  refs: string[],
): Promise<Map<string, SyncPass>> {
  const out = new Map<string, SyncPass>();
  for (const part of chunk([...new Set(refs)], 80)) {
    const rows = await all<SyncPassSql>(
      db,
      `SELECT ${PASS_COLUMNS} FROM passes
       WHERE org_id = ? AND mode = 'live' AND connection_id = ? AND status = 'active'
         AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0
         AND external_ref IN (${placeholders(part.length)})`,
      [orgId, connectionId, ...part],
    );
    for (const r of rows) {
      const pass = toPass(r);
      if (pass?.externalRef && !out.has(pass.externalRef)) out.set(pass.externalRef, pass);
    }
  }
  return out;
}

export async function getPassById(db: D1Database, passId: string): Promise<SyncPass | null> {
  const r = await first<SyncPassSql>(
    db,
    `SELECT ${PASS_COLUMNS} FROM passes WHERE id = ? AND test_data_quarantined = 0`,
    [passId],
  );
  return r ? toPass(r) : null;
}

/** Active linked passes whose next_sync_at has come (never-synced first). */
export async function listDuePassRefs(
  db: D1Database,
  orgId: string,
  connectionId: string,
  now: number,
  limit: number,
): Promise<string[]> {
  const rows = await all<{ external_ref: string }>(
    db,
    `SELECT external_ref FROM passes
     WHERE org_id = ? AND mode = 'live' AND connection_id = ? AND external_ref IS NOT NULL
       AND status = 'active' AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0
       AND (next_sync_at IS NULL OR next_sync_at <= ?)
     ORDER BY next_sync_at IS NOT NULL, next_sync_at LIMIT ?`,
    [orgId, connectionId, now, limit],
  );
  return rows.map((r) => r.external_ref);
}

export async function templateScope(
  db: D1Database,
  templateId: string,
): Promise<{ orgId: string | null; status: string } | null> {
  const r = await first<{ org_id: string | null; status: string }>(
    db,
    'SELECT org_id, status FROM templates WHERE id = ?',
    [templateId],
  );
  return r ? { orgId: r.org_id, status: r.status } : null;
}
