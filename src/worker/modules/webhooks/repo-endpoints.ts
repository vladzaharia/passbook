import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  WebhookApiVersion,
  WebhookEndpointStatus,
} from '../../../shared/contracts/webhooks.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { AuthorityError } from '../../platform/authority-error.ts';
import { all, first } from '../../platform/db.ts';
import { entitled, withinLimit } from '../../platform/entitlements.ts';
import type { FeedFence } from './repo-feed.ts';

export interface EndpointRow {
  id: string;
  orgId: string;
  mode: Mode;
  url: string;
  description: string;
  eventTypes: string[];
  templateIds: string[] | null;
  apiVersion: WebhookApiVersion;
  status: WebhookEndpointStatus;
  /** `capture` stores the signed request in the developer org and sends nothing. */
  target: 'url' | 'capture';
  disabledAt: number | null;
  failingSince: number | null;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** HTTP status of the newest attempted delivery; null for none or no response. */
  lastStatus: number | null;
  /** When the current signing secret was made, and until when a rotated one still signs. */
  secretCreatedAt: number | null;
  previousSecretExpiresAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  url: string;
  description: string;
  event_types: string;
  template_ids: string | null;
  api_version: WebhookApiVersion;
  status: WebhookEndpointStatus;
  target: 'url' | 'capture';
  disabled_at: number | null;
  failing_since: number | null;
  consecutive_failures: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_status?: number | null;
  secret_created_at?: number | null;
  previous_secret_expires_at?: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS = `id, org_id, mode, url, description, event_types, template_ids, api_version, status,
  target, disabled_at, failing_since, consecutive_failures, last_success_at, last_failure_at, created_by,
  created_at, updated_at`;

/** Newest attempted delivery by the primary key (endpoint_id, event_seq): no scan of the backlog. */
const WITH_STATUS = `${COLUMNS}, (SELECT d.last_status FROM webhook_deliveries d
  WHERE d.endpoint_id = webhook_endpoints.id AND d.last_attempt_at IS NOT NULL
  ORDER BY d.event_seq DESC LIMIT 1) AS last_status,
  (SELECT s.created_at FROM webhook_endpoint_secrets s
    WHERE s.endpoint_id = webhook_endpoints.id AND s.expires_at IS NULL) AS secret_created_at,
  (SELECT MAX(s.expires_at) FROM webhook_endpoint_secrets s
    WHERE s.endpoint_id = webhook_endpoints.id) AS previous_secret_expires_at`;

function endpointOf(r: Raw): EndpointRow {
  return {
    id: r.id,
    orgId: r.org_id,
    mode: r.mode,
    url: r.url,
    description: r.description,
    eventTypes: JSON.parse(r.event_types) as string[],
    templateIds: r.template_ids ? (JSON.parse(r.template_ids) as string[]) : null,
    apiVersion: r.api_version,
    status: r.status,
    target: r.target,
    disabledAt: r.disabled_at,
    failingSince: r.failing_since,
    consecutiveFailures: r.consecutive_failures,
    lastSuccessAt: r.last_success_at,
    lastFailureAt: r.last_failure_at,
    lastStatus: r.last_status ?? null,
    secretCreatedAt: r.secret_created_at ?? null,
    previousSecretExpiresAt: r.previous_secret_expires_at ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** By id, fenced by the caller's org and mode: another tenant's endpoint reads as absent. */
export async function getEndpoint(
  db: D1Database,
  fence: FeedFence,
  id: string,
): Promise<EndpointRow | null> {
  const row = await first<Raw>(
    db,
    `SELECT ${WITH_STATUS} FROM webhook_endpoints WHERE id = ? AND org_id = ? AND mode = ?`,
    [id, fence.orgId, fence.mode],
  );
  return row ? endpointOf(row) : null;
}

/** At most 10 rows (the table's cap trigger), oldest first. */
export async function listEndpoints(db: D1Database, fence: FeedFence): Promise<EndpointRow[]> {
  const rows = await all<Raw>(
    db,
    `SELECT ${WITH_STATUS} FROM webhook_endpoints WHERE org_id = ? AND mode = ?
     ORDER BY created_at, id LIMIT 10`,
    [fence.orgId, fence.mode],
  );
  return rows.map(endpointOf);
}

/** Endpoints are per org and mode: any other grant scope would drop the mode fence or the org fence. */
export function assertOrgModeGrant(g: Grant): void {
  if (g.scope !== 'org_mode')
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'Webhook writes need an org_mode grant.');
}

/** Endpoints need the plan's webhooks feature. */
export const webhooksIncluded = (): Check => entitled('webhooks');

/** An endpoint takes a slot of the `webhooks.endpoints` limit, counted across the org's modes. */
export const endpointSlot = (): Check =>
  withinLimit(
    'webhooks.endpoints',
    'SELECT COUNT(*) FROM webhook_endpoints we WHERE we.org_id = {org}',
  );

export interface NewEndpoint {
  id: string;
  url: string;
  description: string;
  eventTypes: readonly string[];
  templateIds: readonly string[] | null;
  apiVersion: WebhookApiVersion;
  /** Default `url`. A capture endpoint is made only through `capture.ts`. */
  target?: 'url' | 'capture';
  createdBy: string | null;
  now: number;
}

/** The grant supplies the org and mode. An 11th endpoint aborts in the cap trigger. */
export function insertEndpoint(g: Grant, e: NewEndpoint): GrantedStatement {
  assertOrgModeGrant(g);
  return g.insertSelect(
    'webhook_endpoints',
    [
      'id',
      'url',
      'description',
      'event_types',
      'template_ids',
      'api_version',
      'target',
      'created_by',
      'created_at',
      'updated_at',
    ],
    [
      e.id,
      e.url,
      e.description,
      JSON.stringify(e.eventTypes),
      e.templateIds ? JSON.stringify(e.templateIds) : null,
      e.apiVersion,
      e.target ?? 'url',
      e.createdBy,
      e.now,
      e.now,
    ],
    { returning: ['id'] },
  );
}

export interface EndpointChanges {
  url?: string;
  description?: string;
  eventTypes?: readonly string[];
  templateIds?: readonly string[] | null;
  apiVersion?: WebhookApiVersion;
  /** A manager resumes (`active`) or pauses; the counters reset on a resume. */
  status?: 'active' | 'paused';
}

export function updateEndpoint(
  g: Grant,
  id: string,
  c: EndpointChanges,
  now: number,
): GrantedStatement {
  assertOrgModeGrant(g);
  const set: Record<string, string | number | null> = { updated_at: now };
  if (c.url !== undefined) set.url = c.url;
  if (c.description !== undefined) set.description = c.description;
  if (c.eventTypes !== undefined) set.event_types = JSON.stringify(c.eventTypes);
  if (c.templateIds !== undefined)
    set.template_ids = c.templateIds ? JSON.stringify(c.templateIds) : null;
  if (c.apiVersion !== undefined) set.api_version = c.apiVersion;
  if (c.status !== undefined) {
    set.status = c.status;
    set.disabled_at = null;
    if (c.status === 'active') {
      set.consecutive_failures = 0;
      set.failing_since = null;
    }
  }
  // `require: 'one'`: an endpoint outside the tenant aborts the batch (authority_denied:lineage), audit included.
  return g.update('webhook_endpoints', { where: { id }, set, require: 'one', returning: ['id'] });
}

/** Deliveries, attempts and secrets go by cascade. */
export function deleteEndpoint(g: Grant, id: string): GrantedStatement {
  assertOrgModeGrant(g);
  return g.delete('webhook_endpoints', { where: { id }, require: 'one', returning: ['id'] });
}

/** The org and mode a stored endpoint belongs to, for by-id routes that authorize against it. */
export async function locateEndpoint(
  db: D1Database,
  id: string,
): Promise<{ orgId: string; mode: Mode } | null> {
  const row = await first<{ org_id: string; mode: Mode }>(
    db,
    'SELECT org_id, mode FROM webhook_endpoints WHERE id = ?',
    [id],
  );
  return row ? { orgId: row.org_id, mode: row.mode } : null;
}
