import { z } from 'zod';
import type { ConnectionDto, ConnectorInfoSchema, Json } from '../../../shared/contracts/index.ts';
import { STALE_DELIVERIES_TEXT } from '../../../shared/copy/connection-warnings.ts';
import { connectors } from '../../connectors/registry.ts';
import type { AnyConnector } from '../../connectors/types.ts';
import type { AppEnv } from '../../platform/env.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ConnectionRow } from './repo.ts';
import type { ArrivalSummary } from './repo-webhook-arrivals.ts';

export function webhookUrl(env: AppEnv, conn: Pick<ConnectionRow, 'id' | 'mode'>): string | null {
  return conn.mode === 'webhook' || conn.mode === 'hybrid'
    ? `${baseUrl(env)}/hooks/connections/${conn.id}`
    : null;
}

type Shown = Pick<ConnectionDto, 'connectorVersion' | 'config'> & {
  /** Set when the stored config is shown as stored because it did not migrate. */
  issue?: 'MIGRATE_FAILED' | 'MIGRATED_INVALID';
};

/**
 * The config as runs see it: one stored by an older connector version is shown migrated, under the
 * current version, so an edit starts from the shape the update path takes. A row that does not migrate
 * is shown as stored, under its stored version.
 */
function shownConfig(c: ConnectionRow): Shown {
  const stored = { connectorVersion: c.connectorVersion, config: c.config };
  const def = connectors.get(c.connectorType);
  if (!def?.migrate || c.connectorVersion === def.version) return stored;
  let migrated: unknown;
  try {
    migrated = def.migrate(c.connectorVersion, c.config);
  } catch {
    // A broken stored config must not fail a listing; `stored` keeps its old version, so clients can tell.
    return { ...stored, issue: 'MIGRATE_FAILED' };
  }
  const parsed = def.configSchema.safeParse(migrated);
  return parsed.success
    ? { connectorVersion: def.version, config: parsed.data as Record<string, Json> }
    : { ...stored, issue: 'MIGRATED_INVALID' };
}

/** Secrets never appear: only whether each credential exists. */
export function toDto(
  env: AppEnv,
  c: ConnectionRow,
  arrivals: ArrivalSummary,
  onIssue?: (code: NonNullable<Shown['issue']>) => void,
): ConnectionDto {
  const shown = shownConfig(c);
  if (shown.issue) onIssue?.(shown.issue);
  return {
    id: c.id,
    orgId: c.orgId,
    connectorType: c.connectorType,
    connectorVersion: shown.connectorVersion,
    name: c.name,
    config: shown.config,
    hasCredential: c.credentialId !== null,
    hasWebhookSecret: c.webhookCredentialId !== null,
    mapping: c.mapping
      ? Object.fromEntries(
          Object.entries(c.mapping).map(([k, v]) => [
            k,
            {
              from: v.from,
              ...(v.transform
                ? {
                    transform: {
                      kind: v.transform.kind as 'enum',
                      ...(v.transform.options ? { options: v.transform.options } : {}),
                    },
                  }
                : {}),
            },
          ]),
        )
      : null,
    defaultTemplateId: c.defaultTemplateId,
    holderEmailField: c.holderEmailField,
    autoCreate: c.autoCreate,
    autoEmail: c.autoEmail,
    onMissing: c.onMissing,
    voidWhen: c.voidWhen,
    webhookPrevUntil: c.webhookPrevCredentialId ? c.webhookPrevUntil : null,
    mode: c.mode,
    intervalSeconds: c.intervalSeconds,
    maxConcurrency: c.maxConcurrency,
    requestsPerMinute: c.requestsPerMinute,
    enabled: c.enabled,
    health:
      c.health === 'unknown' && arrivals.firstVerifiedAt === null && webhookUrl(env, c) !== null
        ? 'awaiting'
        : c.health,
    firstVerifiedArrivalAt: arrivals.firstVerifiedAt,
    warning: arrivals.staleRun
      ? { code: 'stale_deliveries' as const, text: STALE_DELIVERIES_TEXT }
      : null,
    consecutiveFailures: c.consecutiveFailures,
    breakerOpenUntil: c.breakerOpenUntil,
    nextRunAt: c.nextRunAt,
    lastRunAt: c.lastRunAt,
    lastSuccessAt: c.lastSuccessAt,
    lastErrorCode: c.lastErrorCode,
    lastErrorAt: c.lastErrorAt,
    webhookUrl: webhookUrl(env, c),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function jsonSchemaOf(schema: z.ZodType): Json {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
}

export function connectorInfo(def: AnyConnector): z.infer<typeof ConnectorInfoSchema> {
  const caps = def.capabilities;
  return {
    type: def.type,
    version: def.version,
    displayName: def.displayName,
    description: def.description ?? '',
    category: def.category,
    order: def.order,
    capabilities: {
      poll: caps.poll === true,
      delta: caps.delta === true,
      webhook: caps.webhook === true,
      import: caps.import === true,
      snapshot: caps.snapshot === true,
      upload: caps.upload === true,
    },
    configSchema: jsonSchemaOf(def.configSchema),
    secretSchema: def.secretSchema ? jsonSchemaOf(def.secretSchema) : null,
    outputFields: def.outputFields,
    defaults: def.defaults,
    recipes: (def.recipes ?? []).map((r) => ({ ...r, entitled: true })),
    entitled: true,
  };
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null;
}
