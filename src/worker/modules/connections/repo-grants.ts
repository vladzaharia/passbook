import { verifiedWebhookOf, webhookIngressGrant } from '../../jobs/webhook-ingress.ts';
import { type Grant, type GrantedStatement, grant, jobGrant } from '../../platform/authority.ts';
import { type Check, exactlyOne, rawCheck } from '../../platform/authority-checks.ts';
import type { WhereValue } from '../../platform/authority-expr.ts';
import { writePart } from '../../platform/authority-include.ts';
import type { SqlValue } from '../../platform/db.ts';
import { AppError, authorityDenied, type DenyReason } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import type { ConnectionAuthority } from './access.ts';

/** Refusal codes of every connection grant. `config` is the connection's generation (a config change). */
export const CONNECTION_CODES = {
  org: 'ORG_ACCESS_CHANGED',
  actor: 'ACTOR_CHANGED',
  // A scan staff reason: it cannot fire for a connection, but the map must name every reason.
  staff: 'CONNECTION_STAFF_CHANGED',
  config: 'STALE_GENERATION',
  lineage: 'LINEAGE_CHANGED',
  release: 'TEMPLATE_RELEASE_CHANGED',
  retention: 'RETENTION_CHANGED',
  stale: 'STALE',
} as const satisfies Record<DenyReason, string>;

const REASON_OF = new Map<string, DenyReason>(
  (Object.entries(CONNECTION_CODES) as [DenyReason, string][]).map(([reason, code]) => [
    code,
    reason,
  ]),
);

/**
 * Who writes. A request carries its tenant `authority`; a queue, cron or workflow caller omits it and
 * writes as the connection (a `system:` job grant on `orgId`). `orgId` is always the stored row's org.
 */
export interface ConnectionActor {
  orgId: string;
  authority?: ConnectionAuthority | undefined;
}

/** Every table a connection grant writes: the typed ones and the parts. Anything else is refused. */
const CONNECTION_TABLES = [
  'connections',
  'connection_runs',
  'connection_webhook_items',
  'connection_webhook_retention',
  'connection_webhook_legacy_sources',
  'connection_webhook_replays',
  'connection_inbox',
  'webhook_events',
  'workflow_runs',
  'passes',
] as const;

/** Closing stale work with no authority, outside a verified webhook, runs on a platform job grant. */
export function closesOnPlatform(
  ctx: ServiceContext,
  actor: ConnectionActor,
  closing: boolean,
): boolean {
  if (!closing || actor.authority) return false;
  const verified = verifiedWebhookOf(ctx);
  return !(verified && verified.orgId === actor.orgId);
}

/** Connection grants are live-only (0052 CHECK). A request grant also needs the manage capability or scope. */
export function connectionGrant(
  ctx: ServiceContext,
  actor: ConnectionActor,
  action: string,
  checks: Check[] = [],
  target?: string,
  closing = false,
): Grant {
  const a = actor.authority;
  // Closing stale work is not activity: it must finish while the org is suspended, so it is a platform
  // job grant (no org-active check). Every statement and check then names the org itself.
  // Only the verify step of an inbound webhook puts a token on its context; every other job uses jobGrant.
  const verified = verifiedWebhookOf(ctx);
  if (!a && verified && verified.orgId === actor.orgId)
    return webhookIngressGrant(ctx, verified, {
      checks,
      codes: CONNECTION_CODES,
      // The purpose is fixed, so the real action rides in the target for audit and debugging.
      target: target ? `${action}:${target}` : action,
    });
  if (!a && closing)
    return jobGrant(ctx, {
      purpose: `platform.job.connection_${action.replaceAll('.', '_')}`,
      job: 'connection-sync',
      checks,
      codes: CONNECTION_CODES,
      tables: CONNECTION_TABLES,
      ...(target ? { target } : {}),
    });
  if (!a)
    return jobGrant(ctx, {
      purpose: `org_mode.job.connection.${action}`,
      job: 'connection-sync',
      orgId: actor.orgId,
      mode: 'live',
      checks,
      codes: CONNECTION_CODES,
      tables: CONNECTION_TABLES,
      ...(target ? { target } : {}),
    });
  const manages =
    a.kind === 'session' ? a.capability === 'integrations:manage' : a.scope === 'connections:write';
  if (a.orgId !== actor.orgId || a.mode !== 'live' || !manages)
    throw authorityDenied('actor', { codes: CONNECTION_CODES });
  return grant(ctx, {
    purpose: `org_mode.connection.${action}`,
    // A null-org (platform) key names the org it acts on; the grant needs it active. Scopes still apply.
    principal: tenantPrincipal(a),
    checks: [...capabilityChecks(a), ...checks],
    codes: CONNECTION_CODES,
    tables: CONNECTION_TABLES,
    ...(target ? { target } : {}),
  });
}

/** The refusal reason of a connection grant, or null for any other error. */
export function refusalOf(error: unknown): DenyReason | null {
  return error instanceof AppError ? (REASON_OF.get(error.code) ?? null) : null;
}

/**
 * Commits and classifies. `null` is a refusal the caller treats as lost context (stale, disabled,
 * changed, or a job whose org is suspended). A request that lost its org or actor keeps the 403.
 */
export async function commitOrNull(g: Grant, actor: ConnectionActor): Promise<D1Result[] | null> {
  try {
    return await g.commit();
  } catch (error) {
    const reason = refusalOf(error);
    if (reason === null) throw error;
    if (actor.authority && (reason === 'org' || reason === 'actor')) throw error;
    return null;
  }
}

/** Rows a guarded statement returned (`returning`), never `meta.changes`. */
export const rowCount = (result: D1Result | undefined): number => result?.results.length ?? 0;

export interface ConnectionIs {
  id: string;
  generation?: number;
  /** The connection's sync mode (poll, webhook, ...), not the live/test column. */
  syncMode?: string;
  enabled?: boolean;
  /** Only for a closing (platform job) grant, which has no org of its own: names the org the row must be in. */
  orgId?: string;
}

/** The connection is in the actor's org and still has the generation, sync mode and enabled state read. */
export function connectionIs(c: ConnectionIs): Check {
  const where: Record<string, SqlValue> = { id: c.id };
  if (c.generation !== undefined) where.generation = c.generation;
  if (c.syncMode !== undefined) where.mode = c.syncMode;
  if (c.enabled) where.enabled = 1;
  if (c.orgId !== undefined) where.org_id = c.orgId;
  return exactlyOne('connections', where, undefined, 'config');
}

/** The workflow tracking row of this sync instance exists for the connection (not a guarded table). */
export function workflowTracked(instanceId: string, connectionId: string, keyset: string): Check {
  return rawCheck(
    'lineage',
    `EXISTS (SELECT 1 FROM workflow_runs w WHERE w.instance_id = ? AND w.kind = 'connection_sync'
      AND w.target_id = ? AND w.credential_keyset_commitment = ?)`,
    [instanceId, connectionId, keyset],
  );
}

/**
 * A write to a table that is not guarded (workflow_runs, webhook_events, connection_inbox, ...) that
 * commits in the grant's batch. `sql` must select from `authority_grants g WHERE g.id = ?` (or add
 * `AND EXISTS (SELECT 1 FROM authority_grants g WHERE g.id = ?)`), binding `g.id` where it appears.
 */
export function plainWrite(g: Grant, sql: string, params: SqlValue[]): GrantedStatement {
  const [statement] = g.include(writePart(sql, params));
  if (!statement) throw new Error('A part adds one statement.');
  return statement;
}

/** The retention row exists in the actor's org with these values (a lost race reads as `retention`). */
export const retentionIs = (id: string, conds: Record<string, WhereValue> = {}): Check =>
  exactlyOne('connection_webhook_retention', { id, ...conds }, undefined, 'retention');

/** `inList` takes at most 20 values: split ids into statement-sized chunks. */
export const IDS_PER_STATEMENT = 20;
export function chunked<T>(items: readonly T[], size = IDS_PER_STATEMENT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The item was staged under the release snapshot its retention row still carries. */
export const itemReleaseMatches = (retentionId: string, ordinal: number): Check =>
  rawCheck(
    'retention',
    `EXISTS (SELECT 1 FROM connection_webhook_retention r JOIN connection_webhook_items i ON i.retention_id = r.id
      WHERE r.id = ? AND i.ordinal = ? AND r.release_snapshot = i.release_snapshot)`,
    [retentionId, ordinal],
  );
