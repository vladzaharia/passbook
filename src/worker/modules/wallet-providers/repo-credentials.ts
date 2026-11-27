import { type Grant, grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { epochIs } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { mapWalletWriteError } from './wallet-write-errors.ts';

export interface CredentialRow {
  id: string;
  scope: 'platform' | 'org';
  org_id: string | null;
  mode: 'live' | 'test';
  provider: 'google' | 'samsung';
  identity_hash: string;
  identity_hint: string;
  provenance: 'platform' | 'managed' | 'own';
  signer_ref: string | null;
  next_rotation_at: number | null;
  revision: number;
  current_version_id: string | null;
  verified_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
  /** The current version's card map (Samsung): card type to the hash of its card id. */
  card_map?: string | null;
}

const COLUMNS =
  'id, scope, org_id, mode, provider, identity_hash, identity_hint, provenance, signer_ref, next_rotation_at, revision, current_version_id, verified_at, revoked_at, created_at, updated_at, (SELECT v.card_map FROM wallet_credential_versions v WHERE v.id = wallet_credentials.current_version_id) AS card_map';

/** Credentials of one org and mode, or the platform's (`orgId` null, every mode), newest first. */
export function listCredentials(
  db: D1Database,
  where: { orgId: string | null; mode?: string; provider?: string },
): Promise<CredentialRow[]> {
  const params: SqlValue[] = where.orgId === null ? [] : [where.orgId];
  let sql = `SELECT ${COLUMNS} FROM wallet_credentials WHERE ${
    where.orgId === null ? "scope = 'platform'" : "scope = 'org' AND org_id = ?"
  }`;
  if (where.mode) {
    sql += ' AND mode = ?';
    params.push(where.mode);
  }
  if (where.provider) {
    sql += ' AND provider = ?';
    params.push(where.provider);
  }
  return all<CredentialRow>(db, `${sql} ORDER BY created_at DESC, id LIMIT 50`, params);
}

/** The credential `id` inside its scope: the org's own, or a platform one (`orgId` null). Never another org's. */
export function findCredential(
  db: D1Database,
  id: string,
  orgId: string | null,
): Promise<CredentialRow | null> {
  return first<CredentialRow>(
    db,
    `SELECT ${COLUMNS} FROM wallet_credentials WHERE id = ? AND ${
      orgId === null ? "scope = 'platform'" : "scope = 'org' AND org_id = ?"
    }`,
    orgId === null ? [id] : [id, orgId],
  );
}

/** The one active credential of a scope (`orgId` null: the platform's), mode and provider. */
export function findActiveCredential(
  db: D1Database,
  orgId: string | null,
  mode: string,
  provider: string,
): Promise<CredentialRow | null> {
  return first<CredentialRow>(
    db,
    `SELECT ${COLUMNS} FROM wallet_credentials WHERE ${
      orgId === null ? "scope = 'platform'" : "scope = 'org' AND org_id = ?"
    } AND mode = ? AND provider = ? AND revoked_at IS NULL`,
    orgId === null ? [mode, provider] : [orgId, mode, provider],
  );
}

export async function cardMapOf(
  db: D1Database,
  versionId: string | null,
): Promise<Record<string, string>> {
  if (!versionId) return {};
  const row = await first<{ card_map: string }>(
    db,
    'SELECT card_map FROM wallet_credential_versions WHERE id = ?',
    [versionId],
  );
  return row ? (JSON.parse(row.card_map) as Record<string, string>) : {};
}

/** How a writer holds the grant: the purpose, its principal and any capability checks. */
export interface CredentialWriter {
  purpose: string;
  principal: Principal;
  checks: Check[];
  actor: { type: 'user' | 'platform' | 'system' | 'api_key'; id: string | null };
  /** A platform grant names the mode itself; an org_mode grant takes org and mode from its row. */
  platform: boolean;
}

export const CREDENTIAL_TABLES = [
  'wallet_credentials',
  'wallet_credential_versions',
  'wallet_credential_events',
];
const TABLES = CREDENTIAL_TABLES;
const CODES = { config: 'WALLET_ACCOUNT_CONFLICT' };

export interface SaveCredentialInput {
  credentialId: string;
  /** Null creates the credential. */
  expectedRevision: number;
  mode: 'live' | 'test';
  provider: 'google' | 'samsung';
  identityHash: string;
  identityHint: string;
  versionId: string;
  eventId: string;
  cardMap: Record<string, string>;
  envelope: Envelope;
  /** A new credential's provenance and key source; a rotation leaves both. */
  origin?: { provenance: 'managed' | 'own'; signerRef: string | null };
  /** Sets the next service-account key rotation of a platform credential. */
  nextRotationAt?: number | null;
  /** The org brought its own key: PassBook's key rotation no longer reaches this credential. */
  clearSigner?: true;
}

/** The statements of a save, for a grant that also writes the enrolment (the migration commits them as one batch). */
export function stageCredentialSave(
  g: Grant,
  ctx: ServiceContext,
  w: Pick<CredentialWriter, 'actor' | 'platform'>,
  input: SaveCredentialInput,
): void {
  const now = ctx.clock.now();
  const create = input.expectedRevision === 0;
  const revision = input.expectedRevision + 1;
  const origin = input.origin ?? (w.platform ? { provenance: 'platform', signerRef: null } : null);
  if (create)
    g.insertSelect(
      'wallet_credentials',
      [
        'id',
        'scope',
        ...(w.platform ? ['mode'] : []),
        'provider',
        'identity_hash',
        'identity_hint',
        ...(origin ? ['provenance', 'signer_ref'] : []),
        'created_at',
        'updated_at',
      ],
      [
        input.credentialId,
        w.platform ? 'platform' : 'org',
        ...(w.platform ? [input.mode] : []),
        input.provider,
        input.identityHash,
        input.identityHint,
        ...(origin ? [origin.provenance, origin.signerRef] : []),
        now,
        now,
      ],
    );
  g.insertJoined('wallet_credential_versions', {
    parents: { credential_id: input.credentialId },
    columns: [
      'id',
      'identity_hash',
      'card_map',
      'kek_version',
      'iv',
      'wrapped_dek',
      'ciphertext',
      'created_at',
    ],
    values: [
      input.versionId,
      input.identityHash,
      JSON.stringify(input.cardMap),
      input.envelope.kekVersion,
      input.envelope.iv,
      input.envelope.wrappedDek,
      input.envelope.ciphertext,
      now,
    ],
  });
  g.insertJoined('wallet_credential_events', {
    parents: { credential_id: input.credentialId },
    columns: ['id', 'revision', 'kind', 'version_id', 'actor_type', 'actor_id', 'request_id'],
    values: [
      input.eventId,
      revision,
      create ? 'create' : 'rotate',
      input.versionId,
      w.actor.type,
      w.actor.id,
      ctx.requestId,
    ],
  });
  g.update('wallet_credentials', {
    set: {
      revision,
      current_version_id: input.versionId,
      updated_at: now,
      ...(input.nextRotationAt === undefined ? {} : { next_rotation_at: input.nextRotationAt }),
      ...(input.clearSigner ? { signer_ref: null } : {}),
    },
    where: { id: input.credentialId, ...(w.platform ? { scope: 'platform' } : {}) },
  });
}

/**
 * Create (expectedRevision 0) or rotate in one batch: version, event at revision + 1, then the pointer. A
 * stale revision is refused by the grant's epoch check; the unique indexes refuse a second active credential.
 */
export async function saveCredential(
  ctx: ServiceContext,
  w: CredentialWriter,
  input: SaveCredentialInput,
): Promise<void> {
  const create = input.expectedRevision === 0;
  const g = grant(ctx, {
    purpose: w.purpose,
    principal: w.principal,
    tables: TABLES,
    codes: CODES,
    checks: [
      ...w.checks,
      ...(create
        ? []
        : [epochIs('wallet_credentials', input.credentialId, 'revision', input.expectedRevision)]),
    ],
  });
  stageCredentialSave(g, ctx, w, input);
  try {
    await g.commit();
  } catch (error) {
    throw mapWalletWriteError(error);
  }
}

/** The statements of a revoke: the event, then `revoked_at`. The database turns the On enrolments on it Off. */
export function stageCredentialRevoke(
  g: Grant,
  ctx: ServiceContext,
  w: Pick<CredentialWriter, 'actor' | 'platform'>,
  input: { credentialId: string; expectedRevision: number; eventId: string },
): void {
  const now = ctx.clock.now();
  g.insertJoined('wallet_credential_events', {
    parents: { credential_id: input.credentialId },
    columns: ['id', 'revision', 'kind', 'version_id', 'actor_type', 'actor_id', 'request_id'],
    values: [
      input.eventId,
      input.expectedRevision + 1,
      'revoke',
      null,
      w.actor.type,
      w.actor.id,
      ctx.requestId,
    ],
  });
  g.update('wallet_credentials', {
    set: { revision: input.expectedRevision + 1, revoked_at: now, updated_at: now },
    where: { id: input.credentialId, ...(w.platform ? { scope: 'platform' } : {}) },
  });
}

/** Revokes in one batch. */
export async function revokeCredential(
  ctx: ServiceContext,
  w: CredentialWriter,
  input: { credentialId: string; expectedRevision: number; eventId: string },
): Promise<void> {
  const g = grant(ctx, {
    purpose: w.purpose,
    principal: w.principal,
    tables: TABLES,
    codes: CODES,
    checks: [
      ...w.checks,
      epochIs('wallet_credentials', input.credentialId, 'revision', input.expectedRevision),
    ],
  });
  stageCredentialRevoke(g, ctx, w, input);
  try {
    await g.commit();
  } catch (error) {
    throw mapWalletWriteError(error);
  }
}

/** A source's row by id, for reading its scope and version; callers pass an id an enrolment names. */
export function credentialById(db: D1Database, id: string): Promise<CredentialRow | null> {
  return first<CredentialRow>(db, `SELECT ${COLUMNS} FROM wallet_credentials WHERE id = ?`, [id]);
}
