import type { Grant } from '../../platform/authority.ts';
import { writePart } from '../../platform/authority-include.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { mapWalletWriteError } from './wallet-write-errors.ts';

type Mode = 'live' | 'test';
type Provider = 'google' | 'samsung';

export interface EnrolmentRow {
  id: string;
  org_id: string;
  mode: Mode;
  provider: Provider;
  credential_id: string | null;
  credential_source_id: string | null;
  identity_hash: string | null;
  enabled_at: number | null;
  enrolment_revision: number;
  platform_hold_at: number | null;
  platform_hold_reason: string | null;
  revoked_at: number | null;
  /** 1 when the enrolment already has its own HMAC key. */
  has_hmac: number;
}

export const ENROLMENT_TABLES = ['wallet_provider_accounts', 'wallet_enrolment_events'];

export function findEnrolment(
  db: D1Database,
  orgId: string,
  mode: Mode,
  provider: Provider,
): Promise<EnrolmentRow | null> {
  return first<EnrolmentRow>(
    db,
    `SELECT id, org_id, mode, provider, credential_id, credential_source_id, identity_hash, enabled_at,
      enrolment_revision, platform_hold_at, platform_hold_reason, revoked_at,
      hmac_ciphertext IS NOT NULL AS has_hmac
     FROM wallet_provider_accounts WHERE org_id = ? AND mode = ? AND provider = ?`,
    [orgId, mode, provider],
  );
}

/** A row the new model owns: it has a source or events, so the legacy configure route no longer applies. */
export async function isNewModelAccount(
  db: D1Database,
  orgId: string,
  mode: Mode,
  provider: Provider,
): Promise<boolean> {
  const row = await findEnrolment(db, orgId, mode, provider);
  return row !== null && (row.credential_source_id !== null || row.enrolment_revision > 0);
}

export async function orgStatus(db: D1Database, orgId: string): Promise<string | null> {
  return (
    (await first<{ status: string }>(db, 'SELECT status FROM orgs WHERE id = ?', [orgId]))
      ?.status ?? null
  );
}

/** Who placed the newest hold on an account (its newest `hold` event). */
export async function lastHoldActor(db: D1Database, accountId: string): Promise<string | null> {
  return (
    (
      await first<{ a: string | null }>(
        db,
        "SELECT actor_id AS a FROM wallet_enrolment_events WHERE account_id = ? AND kind = 'hold' ORDER BY enrolment_revision DESC LIMIT 1",
        [accountId],
      )
    )?.a ?? null
  );
}

/** The highest event revision, which a hold or release steps past (a stray event cannot block it). */
export async function maxEventRevision(db: D1Database, accountId: string): Promise<number> {
  return (
    (
      await first<{ r: number | null }>(
        db,
        'SELECT MAX(enrolment_revision) AS r FROM wallet_enrolment_events WHERE account_id = ?',
        [accountId],
      )
    )?.r ?? 0
  );
}

/** A successful check of the source's current version from the last 24 h (the database re-checks its own clock). */
export async function freshCheckId(
  db: D1Database,
  credentialId: string,
  versionId: string,
  now: number,
): Promise<string | null> {
  return (
    (
      await first<{ id: string }>(
        db,
        `SELECT id FROM wallet_credential_checks WHERE credential_id = ? AND version_id = ? AND ok = 1
           AND checked_at >= ? ORDER BY checked_at DESC LIMIT 1`,
        [credentialId, versionId, now - 86_400_000],
      )
    )?.id ?? null
  );
}

export interface RoundTrip {
  kind: 'google_save' | 'samsung_added';
  id: string;
}

/** A Test callback received after the org's Test enrolment last named a source (the Live enable's proof). */
export async function testRoundTrip(
  db: D1Database,
  orgId: string,
  provider: Provider,
): Promise<RoundTrip | null> {
  const table =
    provider === 'google'
      ? 'wallet_google_callback_receipts r'
      : 'wallet_samsung_callback_receipts r';
  const event = provider === 'google' ? "r.event_type = 'save'" : "r.event = 'ADDED'";
  const row = await first<{ id: string }>(
    db,
    `SELECT r.id FROM ${table} JOIN wallet_provider_accounts t ON t.id = r.account_id
     WHERE t.org_id = ? AND t.mode = 'test' AND t.provider = ? AND t.credential_source_id IS NOT NULL
       AND r.org_id = t.org_id AND r.mode = 'test' AND ${event}
       AND r.received_at > COALESCE((SELECT MAX(s.created_at) FROM wallet_enrolment_events s
         WHERE s.account_id = t.id AND s.kind = 'source'), 0)
     ORDER BY r.received_at DESC LIMIT 1`,
    [orgId, provider],
  );
  return row ? { kind: provider === 'google' ? 'google_save' : 'samsung_added', id: row.id } : null;
}

export interface EnrolmentStep {
  accountId: string;
  /** Creates the row first (an absent enrolment). */
  isNew: boolean;
  provider: Provider;
  /** The account's `enrolment_revision` the caller read; the update holds only at that value. */
  expectedRevision: number;
  /** The event's revision: expected + 1, or past the highest event for a hold and a release. */
  revision: number;
  event: {
    id: string;
    kind: 'source' | 'enable' | 'disable' | 'hold' | 'release' | 'revoke';
    credentialId?: string;
    checkId?: string;
    roundTrip?: RoundTrip;
    reason?: string;
    actor: { type: 'user' | 'platform' | 'system' | 'api_key'; id: string | null };
    /** The stamp `enabled_at`, `revoked_at` or `platform_hold_at` repeats; within 5 s of the database clock. */
    createdAt?: number;
  };
  /** The account columns this step moves, a fixed set chosen by the caller (never a request value). */
  set: Record<string, SqlValue>;
  /** More statements for the same batch, after the account update (the migration's audit and credential revoke). */
  after?: (g: Grant) => void;
}

/** Adds the event and the account update of one enrolment step to the grant, without committing it. */
export function addEnrolmentStep(ctx: ServiceContext, g: Grant, step: EnrolmentStep): void {
  const now = ctx.clock.now();
  const e = step.event;
  if (step.isNew)
    g.include(
      writePart(
        `INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, created_at, updated_at)
         SELECT ?, {org}, {mode}, ?, ?, ? WHERE {grant} ON CONFLICT DO NOTHING`,
        [step.accountId, step.provider, now, now],
      ),
    );
  g.insertSelect(
    'wallet_enrolment_events',
    [
      'id',
      'account_id',
      'provider',
      'enrolment_revision',
      'kind',
      'credential_id',
      'check_id',
      'round_trip_kind',
      'round_trip_id',
      'reason',
      'actor_type',
      'actor_id',
      'request_id',
      ...(e.createdAt === undefined ? [] : ['created_at']),
    ],
    [
      e.id,
      step.accountId,
      step.provider,
      step.revision,
      e.kind,
      e.credentialId ?? null,
      e.checkId ?? null,
      e.roundTrip?.kind ?? null,
      e.roundTrip?.id ?? null,
      e.reason ?? null,
      e.actor.type,
      e.actor.id,
      ctx.requestId,
      ...(e.createdAt === undefined ? [] : [e.createdAt]),
    ],
  );
  const columns = Object.keys(step.set);
  g.include(
    writePart(
      `UPDATE wallet_provider_accounts SET ${[...columns, 'enrolment_revision', 'updated_at']
        .map((c) => `${c} = ?`)
        .join(', ')}
       WHERE id = ? AND org_id = {org} AND mode = {mode} AND enrolment_revision = ? AND {grant}`,
      [
        ...columns.map((c) => step.set[c]),
        step.revision,
        now,
        step.accountId,
        step.expectedRevision,
      ],
    ),
  );
  step.after?.(g);
}

/** The event and the account update of one enrolment step, in the grant's batch. Throws the mapped refusal. */
export async function commitEnrolmentStep(
  ctx: ServiceContext,
  g: Grant,
  step: EnrolmentStep,
): Promise<void> {
  addEnrolmentStep(ctx, g, step);
  try {
    await g.commit();
  } catch (error) {
    throw mapWalletWriteError(error);
  }
}

export function enrolmentsOf(db: D1Database, orgId: string, mode: Mode): Promise<EnrolmentRow[]> {
  return all<EnrolmentRow>(
    db,
    `SELECT id, org_id, mode, provider, credential_id, credential_source_id, identity_hash, enabled_at,
      enrolment_revision, platform_hold_at, platform_hold_reason, revoked_at,
      hmac_ciphertext IS NOT NULL AS has_hmac
     FROM wallet_provider_accounts WHERE org_id = ? AND mode = ?`,
    [orgId, mode],
  );
}
