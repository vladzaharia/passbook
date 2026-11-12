import { grantedBatch } from '../../platform/authority.ts';
import { rawCheck } from '../../platform/authority-checks.ts';
import { gt } from '../../platform/authority-expr.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { DELIVERY_CODES, deliveryGrants } from '../delivery/delivery-actor.ts';
import type { EmailOutput } from '../delivery/repo-issuance-intent-fence.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import type { CaptureReference, CaptureSnapshot } from './binding.ts';
import { snapshotFence } from './repo-snapshot-fence.ts';

export interface CapturedRow {
  id: string;
  org_id: string;
  pass_id: string | null;
  bundle_id: string | null;
  outbox_id: string | null;
  recipient: string;
  subject: string;
  html: string;
  text: string;
  attached: number;
  intent: string | null;
  created_at: number;
}

export type CapturedRef = CaptureReference & { id: string };

export interface NewCaptured {
  id: string;
  org_id: string;
  pass_id: string | null;
  bundle_id: string | null;
  outbox_id: string;
  recipient: string;
  subject: string;
  html: string;
  text: string;
  attached: boolean;
  intent: string;
  created_at: number;
}

const ORG_CODE = 'ORG_INACTIVE';
const ACTOR_CODE = 'ACTOR_REVOKED';
const CAPTURE_CODES = { ...DELIVERY_CODES, org: ORG_CODE, actor: ACTOR_CODE };

/** What a capture reports: stored, or the code its outbox row is cancelled with. */
export type CaptureResult = 'captured' | 'DELIVERY_STALE' | 'ORG_INACTIVE' | 'ACTOR_REVOKED';

/**
 * The capture row and the outbox row's end (`sent`, `TEST_MODE`) are one batch under the actor
 * captured when the mail was queued, with the lineage checks of its output. A lost lease, revoked
 * membership, disabled user, suspended org, transfer or quarantine stores nothing. A capture that
 * already exists for the outbox row only finishes it.
 */
export async function insertCaptured(
  ctx: ServiceContext,
  row: NewCaptured,
  lease: string,
  output: EmailOutput,
  mode: 'test',
  payload: string,
): Promise<CaptureResult> {
  const existing = await first(ctx.env.DB, 'SELECT 1 FROM captured_emails WHERE outbox_id = ?', [
    row.outbox_id,
  ]);
  const grants = deliveryGrants(ctx, [output.actor, output.also], {
    action: 'capture',
    orgId: row.org_id,
    mode,
    checks: [
      ...output.checks,
      rawCheck(
        'lineage',
        'EXISTS (SELECT 1 FROM outbox WHERE id = ? AND json(payload) = json(?))',
        [row.outbox_id, payload],
      ),
    ],
    target: row.outbox_id,
    codes: CAPTURE_CODES,
  });
  const g = grants[0];
  if (!g) return 'DELIVERY_STALE';
  if (!existing)
    g.insertSelect(
      'captured_emails',
      [
        'id',
        'pass_id',
        'bundle_id',
        'outbox_id',
        'recipient',
        'subject',
        'html',
        'text',
        'attached',
        'intent',
        'created_at',
      ],
      [
        row.id,
        row.pass_id,
        row.bundle_id,
        row.outbox_id,
        row.recipient,
        row.subject,
        row.html,
        row.text,
        row.attached ? 1 : 0,
        row.intent,
        row.created_at,
      ],
    );
  g.update('outbox', {
    set: {
      state: 'sent',
      lease: null,
      finished_at: row.created_at,
      error_code: 'TEST_MODE',
      provider_id: `captured:${row.outbox_id}`,
      coalesce_key: null,
    },
    where: {
      id: row.outbox_id,
      kind: 'email',
      state: 'processing',
      lease,
      provider_id: null,
      available_at: gt(row.created_at),
    },
    require: 'one',
  });
  try {
    await grantedBatch(ctx.env.DB, grants);
    return 'captured';
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === ORG_CODE) return ORG_CODE;
    if (error.code === ACTOR_CODE) return ACTOR_CODE;
    if (error.code === 'DELIVERY_STALE') return 'DELIVERY_STALE';
    throw error;
  }
}

export type InboxAuthority = Extract<TenantPassWrite, { kind: 'session' }>;

/** An inbox statement always binds the active session and grant to the capture's actual org. */
export function inboxAuthorityFence(
  authority: InboxAuthority,
  capability: 'passes:read' | 'passes:operate',
  now: number,
): { sql: string; params: SqlValue[] } {
  const allowed =
    authority.kind === 'session' &&
    authority.mode === 'test' &&
    (authority.capability === capability ||
      (capability === 'passes:read' && authority.capability === 'passes:operate'));
  if (!allowed) return { sql: '0', params: [] };
  return {
    sql: `c.org_id = ? AND (${tenantPassAuthoritySql(authority)})`,
    params: [authority.orgId, ...tenantPassAuthorityParams(authority, now)],
  };
}

export interface CapturedFilter {
  orgId: string;
  /** Exclusive: the last id of the previous page. Ids are UUIDv7, so id order is time order. */
  cursor?: string | undefined;
  limit: number;
}

const REFERENCE = 'c.id, c.org_id, c.pass_id, c.bundle_id, c.recipient, c.attached, c.intent';
const SUMMARY = `c.id, c.org_id, c.pass_id, c.bundle_id, c.outbox_id, c.recipient, c.subject,
  '' AS html, '' AS text, c.attached, c.intent, c.created_at`;

/** Mode is the mode of what the message is about: a capture of a Live pass or bundle is never shown. */
const TEST_MODE_ONLY = `(c.pass_id IS NULL OR EXISTS (SELECT 1 FROM passes tp WHERE tp.id = c.pass_id AND tp.mode = 'test'))
  AND (c.bundle_id IS NULL OR EXISTS (SELECT 1 FROM bundles tb WHERE tb.id = c.bundle_id AND tb.mode = 'test'))`;

/** Visibility is org, mode and membership only: the stored message, whatever the pass did since. */
export function listCaptured(
  db: D1Database,
  f: CapturedFilter,
  authority: InboxAuthority,
  now: number,
): Promise<CapturedRow[]> {
  const fence = inboxAuthorityFence(authority, 'passes:read', now);
  const where = ['c.org_id = ?', fence.sql, TEST_MODE_ONLY];
  const params: SqlValue[] = [f.orgId, ...fence.params];
  if (f.cursor) {
    where.push('c.id < ?');
    params.push(f.cursor);
  }
  return all<CapturedRow>(
    db,
    `SELECT ${SUMMARY} FROM captured_emails c WHERE ${where.join(' AND ')}
     ORDER BY c.id DESC LIMIT ?`,
    [...params, f.limit],
  );
}

/** The stored message with its content, under the same org, mode and membership rule. */
export function getCaptured(
  db: D1Database,
  id: string,
  authority: InboxAuthority,
  now: number,
): Promise<CapturedRow | null> {
  const fence = inboxAuthorityFence(authority, 'passes:read', now);
  return first<CapturedRow>(
    db,
    `SELECT c.* FROM captured_emails c WHERE c.id = ? AND ${fence.sql} AND ${TEST_MODE_ONLY}`,
    [id, ...fence.params],
  );
}

/** Binding metadata of one capture, for the forwarding checks. */
export function getCapturedReference(
  db: D1Database,
  id: string,
  authority: InboxAuthority,
  now: number,
): Promise<CapturedRef | null> {
  const fence = inboxAuthorityFence(authority, 'passes:read', now);
  return first<CapturedRef>(
    db,
    `SELECT ${REFERENCE} FROM captured_emails c WHERE c.id = ? AND ${fence.sql} AND ${TEST_MODE_ONLY}`,
    [id, ...fence.params],
  );
}

/** Forwarding only: content is read while the authenticated snapshot is still current. */
export function readCaptured(
  db: D1Database,
  ref: CapturedRef,
  snapshot: CaptureSnapshot,
  detail: boolean,
  authority: InboxAuthority,
  now: number,
): Promise<CapturedRow | null> {
  const fence = snapshotFence(snapshot);
  const access = inboxAuthorityFence(authority, 'passes:read', now);
  return first<CapturedRow>(
    db,
    `SELECT ${detail ? 'c.*' : SUMMARY} FROM captured_emails c
     WHERE c.id = ? AND c.org_id = ? AND c.pass_id IS ? AND c.bundle_id IS ?
       AND c.recipient = ? AND c.attached = ? AND c.intent = ?
       AND ${fence.sql} AND ${access.sql}`,
    [
      ref.id,
      ref.org_id,
      ref.pass_id,
      ref.bundle_id,
      ref.recipient,
      ref.attached,
      ref.intent,
      ...fence.params,
      ...access.params,
    ],
  );
}
