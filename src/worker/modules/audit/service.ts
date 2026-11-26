import type { z } from 'zod';
import type { AuditEntrySchema, AuditQuerySchema } from '../../../shared/contracts/audit.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { proveCapability } from '../../platform/auth-capability.ts';
import type { Actor } from '../../platform/context.ts';
import { ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireOrgCapability } from '../orgs/access.ts';
import { orgIdOf, tenantAuthorityOf } from '../passes/http.ts';
import { redactForRead, safeLabel } from './redact.ts';
import { REKEYED_ACTION, rekeyedDetail } from './rekeyed-detail.ts';
import {
  type AuditRow,
  auditStmt,
  hiddenOrgLabels,
  labelKey,
  listAuditRows,
  loadLabels,
  personalOrgLabels,
} from './repo.ts';
import { tenantSettingsDetail } from './settings-detail.ts';
import type { AuditEntry } from './types.ts';

export { diffFields } from './redact.ts';

/** Audit fields for a request actor. */
export function auditActor(actor: Actor): Pick<AuditEntry, 'actorType' | 'actorId'> {
  return { actorType: actor.type, actorId: actor.id };
}

/** Every module records mutations through this. Detail is redacted again here as a backstop. */
export async function recordAudit(ctx: ServiceContext, entry: AuditEntry): Promise<void> {
  await auditStmt(ctx.env.DB, ctx, entry).run();
}

type Query = z.infer<typeof AuditQuerySchema>;
type Dto = z.infer<typeof AuditEntrySchema>;

function decodeCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  const id = /^\d+$/.test(cursor) ? Number(cursor) : Number.NaN;
  if (!Number.isSafeInteger(id)) throw new ValidationError('Invalid cursor.', [], 'INVALID_CURSOR');
  return id;
}

type AuditScope =
  | {
      kind: 'tenant';
      orgId: string;
      reader: { userId: string; membershipId: string } | { keyId: string; now: number };
    }
  | { kind: 'platform' };

// UUIDs are identifiers, not capability tokens. Other secret-looking values are omitted.
function safeId(id: string | null): string | null {
  if (!id) return null;
  return /^(?:org:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : safeLabel(id);
}

function toDto(
  row: AuditRow,
  labels: Map<string, string | null>,
  tenant: boolean,
  orgLabels: Map<string, string>,
): Dto {
  const actorKey = row.actor_id ? labelKey(row.actor_type, row.actor_id) : null;
  const targetKey =
    row.target_type && row.target_id ? labelKey(row.target_type, row.target_id) : null;
  const actorId = !tenant || (actorKey && labels.has(actorKey)) ? safeId(row.actor_id) : null;
  const targetId = !tenant || (targetKey && labels.has(targetKey)) ? safeId(row.target_id) : null;
  return {
    id: row.id,
    at: row.at,
    orgId: row.org_id,
    orgLabel: (row.org_id && orgLabels.get(row.org_id)) || null,
    actorType: row.actor_type,
    actorId,
    actorLabel: actorId && actorKey ? (labels.get(actorKey) ?? null) : null,
    action: row.action,
    targetType: row.target_type,
    targetId,
    targetLabel: targetId && targetKey ? (labels.get(targetKey) ?? null) : null,
    requestId: safeId(row.request_id),
    detail: row.detail
      ? row.action === REKEYED_ACTION
        ? (rekeyedDetail(JSON.parse(row.detail)) as Dto['detail'])
        : (redactForRead(
            tenant && row.action === 'settings.update'
              ? tenantSettingsDetail(JSON.parse(row.detail))
              : JSON.parse(row.detail),
            tenant,
          ) as Dto['detail'])
      : null,
  };
}

const KEY_WINDOW_MS = 90 * 86_400_000;
const KEY_PAGE_LIMIT = 100;

/** A key reads at most 90 days at a time, named by `from`, and a page of at most 100 (an export pages itself). */
export function assertKeyWindow(ctx: ServiceContext, query: Query, paged: boolean): void {
  const from = query.createdAfter ?? query.from;
  const to = query.createdBefore ?? query.to ?? ctx.clock.now();
  if (from === undefined)
    throw new ValidationError(
      'Send from: a key reads up to 90 days at a time.',
      [],
      'AUDIT_WINDOW_REQUIRED',
    );
  if (to - from > KEY_WINDOW_MS)
    throw new ValidationError('A key reads up to 90 days at a time.', [], 'AUDIT_WINDOW_TOO_WIDE');
  if (paged && query.limit > KEY_PAGE_LIMIT)
    throw new ValidationError(
      `A key reads at most ${KEY_PAGE_LIMIT} entries a page.`,
      [],
      'AUDIT_LIMIT_TOO_HIGH',
    );
}

/** The org's log for a member with `audit:read`, or for a key holding it (its own org only). */
export async function listTenantAudit(ctx: ServiceContext, auth: AuthContext, query: Query) {
  const orgId = orgIdOf(auth, query.orgId);
  if (auth.kind === 'api_key' && auth.orgId === null) throw new ForbiddenError();
  let reader: { userId: string; membershipId: string } | { keyId: string; now: number };
  if (auth.kind === 'api_key') {
    const authority = await tenantAuthorityOf(ctx, auth, orgId, 'audit:read');
    if (authority.kind !== 'api_key') throw new ForbiddenError();
    reader = { keyId: authority.keyId, now: ctx.clock.now() };
  } else if (auth.kind === 'session') {
    const membership = await requireOrgCapability(ctx, auth.userId, orgId, 'audit:read');
    proveCapability(auth, 'audit:read');
    reader = { userId: auth.userId, membershipId: membership.id };
  } else throw new ForbiddenError();
  return listAudit(ctx, query, { kind: 'tenant', orgId, reader });
}

export async function listPlatformAudit(ctx: ServiceContext, query: Query) {
  return listAudit(ctx, query, { kind: 'platform' });
}

async function listAudit(
  ctx: ServiceContext,
  query: Query,
  scope: AuditScope,
): Promise<{ items: Dto[]; nextCursor: string | null }> {
  const rows = await listAuditRows(
    ctx.env.DB,
    {
      orgId: scope.kind === 'tenant' ? scope.orgId : query.orgId,
      ...(scope.kind === 'tenant' ? { tenant: scope.reader } : {}),
      actorId: query.actorId,
      action: query.action,
      excludeAction: query.excludeAction,
      targetType: query.targetType,
      targetId: query.targetId,
      from: query.createdAfter ?? query.from,
      to: query.createdBefore ?? query.to,
      before: decodeCursor(query.cursor),
    },
    query.limit + 1,
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const refs = page.flatMap((r) => [
    ...(r.actor_id ? [{ type: r.actor_type, id: r.actor_id }] : []),
    ...(r.target_type && r.target_id ? [{ type: r.target_type, id: r.target_id }] : []),
  ]);
  const labels = await loadLabels(
    ctx.env.DB,
    refs,
    scope.kind === 'tenant' ? scope.orgId : undefined,
  );
  const orgIds = [...new Set(page.flatMap((r) => (r.org_id ? [r.org_id] : [])))];
  const orgLabels =
    scope.kind === 'platform'
      ? new Map([
          ...(await hiddenOrgLabels(ctx.env.DB, orgIds)),
          ...(await personalOrgLabels(ctx.env.DB, orgIds)),
        ])
      : new Map<string, string>();
  return {
    items: page.map((r) => toDto(r, labels, scope.kind === 'tenant', orgLabels)),
    nextCursor: rows.length > query.limit && last ? String(last.id) : null,
  };
}
