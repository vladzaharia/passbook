import { z } from 'zod';
import type { ConnectionDto, ConnectorInfoSchema, Json } from '../../../shared/contracts/index.ts';
import type { AnyConnector } from '../../connectors/types.ts';
import type { AppEnv } from '../../platform/env.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ConnectionRow } from './repo.ts';

export function webhookUrl(env: AppEnv, conn: Pick<ConnectionRow, 'id' | 'mode'>): string | null {
  return conn.mode === 'webhook' || conn.mode === 'hybrid'
    ? `${baseUrl(env)}/hooks/connections/${conn.id}`
    : null;
}

/** Secrets never appear: only whether each credential exists. */
export function toDto(env: AppEnv, c: ConnectionRow): ConnectionDto {
  return {
    id: c.id,
    orgId: c.orgId,
    connectorType: c.connectorType,
    connectorVersion: c.connectorVersion,
    name: c.name,
    config: c.config,
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
    mode: c.mode,
    intervalSeconds: c.intervalSeconds,
    maxConcurrency: c.maxConcurrency,
    requestsPerMinute: c.requestsPerMinute,
    enabled: c.enabled,
    health: c.health,
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
    capabilities: {
      poll: caps.poll === true,
      delta: caps.delta === true,
      webhook: caps.webhook === true,
      import: caps.import === true,
      snapshot: caps.snapshot === true,
    },
    configSchema: jsonSchemaOf(def.configSchema),
    secretSchema: def.secretSchema ? jsonSchemaOf(def.secretSchema) : null,
    outputFields: def.outputFields,
    defaults: def.defaults,
  };
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null;
}
