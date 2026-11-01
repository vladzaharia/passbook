import { connectors } from '../../connectors/registry.ts';
import {
  type AnyConnector,
  type ConnectorContext,
  ConnectorError,
  type ConnectorErrorCode,
} from '../../connectors/types.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import { createSafeFetch, platformHostsOf } from '../../platform/safe-fetch.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getDeps } from './deps.ts';
import type { ConnectionRow } from './repo.ts';
import { readConnectorSecrets, readWebhookSecret } from './secrets.ts';

export interface Prepared {
  def: AnyConnector;
  cc: ConnectorContext<unknown, unknown>;
  intervalMs: number;
  maxConcurrency: number;
  requestsPerMinute: number;
}

export interface Failure {
  code: ConnectorErrorCode | 'INTERNAL';
  httpStatus: number | null;
  retryAfterMs: number | null;
}

/** Maps anything thrown while talking to an upstream to a stable code. Never carries upstream text. */
export function classify(error: unknown): Failure {
  if (error instanceof ConnectorError) {
    return {
      code: error.code,
      httpStatus: error.httpStatus ?? null,
      retryAfterMs: error.retryAfterMs ?? null,
    };
  }
  if (error instanceof AppError) {
    const code =
      error.code === 'TIMEOUT' ? 'TIMEOUT' : error.code === 'UNSAFE_URL' ? 'CONFIG' : 'UPSTREAM';
    return { code, httpStatus: null, retryAfterMs: null };
  }
  return { code: 'INTERNAL', httpStatus: null, retryAfterMs: null };
}

/** Decrypts secrets and builds the connector context. Throws ConnectorError('CONFIG') on bad stored data. */
export async function prepare(
  sctx: ServiceContext,
  conn: ConnectionRow,
  options: { signal?: AbortSignal } = {},
): Promise<Prepared> {
  const def = connectors.get(conn.connectorType);
  if (!def) throw new ConnectorError('CONFIG', { permanent: true });
  const rawConfig =
    conn.connectorVersion !== def.version && def.migrate
      ? def.migrate(conn.connectorVersion, conn.config)
      : conn.config;
  const config = def.configSchema.safeParse(rawConfig);
  if (!config.success) throw new ConnectorError('CONFIG', { permanent: true });
  let secrets: unknown;
  if (def.secretSchema) {
    const parsed = def.secretSchema.safeParse((await readConnectorSecrets(sctx, conn)) ?? {});
    if (!parsed.success) throw new ConnectorError('CONFIG', { permanent: true });
    secrets = parsed.data;
  }
  const webhookSecret = await readWebhookSecret(sctx, conn);
  const timeoutMs = def.defaults.timeoutMs;
  const deps = getDeps();
  const fetch = createSafeFetch({
    platformHosts: platformHostsOf(sctx.env),
    timeoutMs,
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const cc: ConnectorContext<unknown, unknown> = {
    connection: {
      id: conn.id,
      orgId: conn.orgId,
      generation: conn.generation,
      config: config.data,
    },
    secrets,
    ...(webhookSecret ? { webhookSecret } : {}),
    now: () => sctx.clock.now(),
    fetch,
    signal: options.signal ?? AbortSignal.timeout(10 * 60_000),
    log: (event, data) => sctx.log.info(`connector.${event}`, { connectionId: conn.id, ...data }),
  };
  return {
    def,
    cc,
    intervalMs: (conn.intervalSeconds ?? def.defaults.intervalSeconds) * 1000,
    maxConcurrency: conn.maxConcurrency ?? def.defaults.maxConcurrency,
    requestsPerMinute: conn.requestsPerMinute ?? def.defaults.requestsPerMinute,
  };
}

/** Milliseconds to wait after `count` requests so the average stays within the per-minute budget. */
export function paceMs(count: number, requestsPerMinute: number): number {
  return Math.ceil((count * 60_000) / requestsPerMinute);
}
