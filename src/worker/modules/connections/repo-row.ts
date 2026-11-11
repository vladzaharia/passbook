import type { Json } from '../../../shared/contracts/common.ts';
import type { ConnectionRow, Health, MappingEntry, Mode, OnMissing } from './repo.ts';

export interface ConnectionSql {
  id: string;
  org_id: string;
  connector_type: string;
  connector_version: number;
  name: string;
  config: string;
  credential_id: string | null;
  webhook_credential_id: string | null;
  mapping: string | null;
  default_template_id: string | null;
  holder_email_field: string | null;
  auto_create: number;
  auto_email: number;
  on_missing: OnMissing;
  mode: Mode;
  interval_seconds: number | null;
  max_concurrency: number | null;
  requests_per_minute: number | null;
  enabled: number;
  generation: number;
  health: Health;
  consecutive_failures: number;
  breaker_open_until: number | null;
  cursor: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  last_success_at: number | null;
  last_error_code: string | null;
  last_error_at: number | null;
  created_at: number;
  updated_at: number;
}

export function toRow(r: ConnectionSql): ConnectionRow {
  return {
    id: r.id,
    orgId: r.org_id,
    connectorType: r.connector_type,
    connectorVersion: r.connector_version,
    name: r.name,
    config: JSON.parse(r.config) as Record<string, Json>,
    credentialId: r.credential_id,
    webhookCredentialId: r.webhook_credential_id,
    mapping: r.mapping ? (JSON.parse(r.mapping) as Record<string, MappingEntry>) : null,
    defaultTemplateId: r.default_template_id,
    holderEmailField: r.holder_email_field,
    autoCreate: r.auto_create === 1,
    autoEmail: r.auto_email === 1,
    onMissing: r.on_missing,
    mode: r.mode,
    intervalSeconds: r.interval_seconds,
    maxConcurrency: r.max_concurrency,
    requestsPerMinute: r.requests_per_minute,
    enabled: r.enabled === 1,
    generation: r.generation,
    health: r.health,
    consecutiveFailures: r.consecutive_failures,
    breakerOpenUntil: r.breaker_open_until,
    cursor: r.cursor,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastSuccessAt: r.last_success_at,
    lastErrorCode: r.last_error_code,
    lastErrorAt: r.last_error_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
