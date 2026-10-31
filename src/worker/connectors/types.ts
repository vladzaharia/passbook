import type { ZodType } from 'zod';
import type { Json } from '../../shared/contracts/common.ts';
import type { SafeFetch } from '../platform/safe-fetch.ts';

export type UpstreamRecord = Record<string, Json>;

export interface ConnectorCapabilities {
  poll?: true;
  delta?: true;
  webhook?: true;
  import?: true;
  snapshot?: true;
}

export interface ConnectorOutputField {
  type: 'string' | 'number' | 'boolean' | 'date';
  description?: string;
}

export interface ConnectorContext<C, S> {
  connection: { id: string; orgId: string; generation: number; config: C };
  /** Decrypted per run; never the Worker env. */
  secrets: S;
  /** Decrypted shared secret for inbound webhooks; absent when none is set. */
  webhookSecret?: string;
  now(): number;
  /** HTTPS-only, public hosts, no redirects, timeout and size caps. */
  fetch: SafeFetch;
  signal: AbortSignal;
  /** Redacted; goes to connection_runs and Analytics Engine. */
  log(event: string, data?: Record<string, string | number>): void;
}

export type RecordResult =
  | { status: 'ok'; record: UpstreamRecord; holderEmail?: string; etag?: string }
  | { status: 'not_modified' }
  | { status: 'not_found' };

export interface ConnectorDefinition<C = unknown, S = unknown> {
  /** Stable id, e.g. 'http-json'. */
  type: string;
  /** Bump when the config or secret shape changes (and provide migrate). */
  version: number;
  displayName: string;
  capabilities: ConnectorCapabilities;
  /** Non-secret fields; also drives the admin form. */
  configSchema: ZodType<C>;
  /** Write-only fields; never returned by the API. */
  secretSchema?: ZodType<S>;
  outputFields: Record<string, ConnectorOutputField>;
  defaults: {
    intervalSeconds: number;
    maxConcurrency: number;
    requestsPerMinute: number;
    timeoutMs: number;
  };
  migrate?(oldVersion: number, config: unknown): C;
  /** Every URL the connector will fetch; checked against the SSRF rules at save time. */
  urls?(config: C): string[];

  test?(ctx: ConnectorContext<C, S>): Promise<{ ok: true; detail?: string }>;
  fetchRecord(ctx: ConnectorContext<C, S>, ref: string): Promise<RecordResult>;
  listChanges?(
    ctx: ConnectorContext<C, S>,
    cursor: string | null,
  ): Promise<{
    changes: { ref: string; record?: UpstreamRecord; deleted?: boolean }[];
    cursor: string;
    hasMore: boolean;
  }>;
  /** Throws ConnectorError('AUTH') when the signature is invalid. */
  verifyWebhook?(
    ctx: ConnectorContext<C, S>,
    req: Request,
  ): Promise<{
    eventId: string;
    refs: string[];
    records?: Record<string, UpstreamRecord>;
    deleted?: string[];
  }>;
  importRecords?(
    ctx: ConnectorContext<C, S>,
    cursor: string | null,
  ): Promise<{
    records: { ref: string; record: UpstreamRecord; holderEmail?: string }[];
    cursor: string | null;
  }>;
}

export type ConnectorErrorCode =
  | 'AUTH'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'UPSTREAM'
  | 'TIMEOUT'
  | 'INVALID_PAYLOAD'
  | 'CONFIG';

/** AUTH and TIMEOUT mark the connection unhealthy and never alter passes. */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly permanent: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  constructor(
    code: ConnectorErrorCode,
    options: { permanent?: boolean; retryAfterMs?: number; httpStatus?: number } = {},
  ) {
    super(code);
    this.name = 'ConnectorError';
    this.code = code;
    this.permanent = options.permanent ?? false;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: registries hold connectors of differing config and secret types
export type AnyConnector = ConnectorDefinition<any, any>;
