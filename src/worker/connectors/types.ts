import type { ZodType } from 'zod';
import type { Json } from '../../shared/contracts/common.ts';
import type { ConnectionFileFormat } from '../../shared/contracts/connection-files.ts';
import type { ConnectorCategory, RecipeInfo } from '../../shared/contracts/connections.ts';
import type { SafeFetch } from '../platform/safe-fetch.ts';

export type UpstreamRecord = Record<string, Json>;

export interface ConnectorCapabilities {
  poll?: true;
  delta?: true;
  webhook?: true;
  import?: true;
  snapshot?: true;
  /** Records come from uploaded files, read through `ctx.files`. */
  upload?: true;
}

export interface ConnectorOutputField {
  type: 'string' | 'number' | 'boolean' | 'date';
  description?: string;
}

/** An uploaded file as a connector sees it: counts and column labels, never the file name. */
export interface ConnectorFile {
  id: string;
  /** Null for a draft. */
  revision: number | null;
  format: ConnectionFileFormat;
  rows: number;
  /** Column labels in file order. */
  columns: readonly string[];
  /** Pages of rows written for this file, numbered from 0. */
  pages: number;
  skipped: { noId: number; duplicate: number };
}

/** A row's place in a file: refs sort by `ref`; `digest` is 16 hex of the canonical record's SHA-256. */
export interface ConnectorFileRef {
  ref: string;
  digest: string;
  page: number;
}

/**
 * Read-only files of one connection (or the draft of an unsaved test). Connectors never see D1 or R2;
 * every read is scoped to the connection's org. A missing or deleted file throws ConnectorError('CONFIG').
 */
export interface ConnectionFilesPort {
  /** The current revision, or the draft for an unsaved test; null when there is none. */
  current(): Promise<ConnectorFile | null>;
  /** Earlier revisions still kept, newest first. Empty for a draft. */
  previous(limit: number): Promise<ConnectorFile[]>;
  /** One page of rows in file order. */
  page(fileId: string, n: number): Promise<{ ref: string; record: UpstreamRecord }[]>;
  refs(fileId: string): Promise<ConnectorFileRef[]>;
  /** One row, or null when the file has no such ref. */
  find(fileId: string, ref: string): Promise<UpstreamRecord | null>;
}

export interface ConnectorContext<C, S> {
  connection: { id: string; orgId: string; generation: number; config: C };
  /** Decrypted per run; never the Worker env. */
  secrets: S;
  /** Decrypted shared secret for inbound webhooks; absent when none is set. Equals `webhookSecrets[0]`. */
  webhookSecret?: string;
  /** Current secret first, then the previous one while its overlap lasts. At most two. */
  webhookSecrets?: readonly string[];
  now(): number;
  /** HTTPS-only, public hosts, no redirects, timeout and size caps; pinned to `egress` when declared. */
  fetch: SafeFetch;
  /** Set only for a connector with the `upload` capability. */
  files?: ConnectionFilesPort;
  signal: AbortSignal;
  /** Redacted; goes to connection_runs and Analytics Engine. */
  log(event: string, data?: Record<string, string | number>): void;
}

/** Why a verified webhook was accepted but not applied. A closed list: sender text never reaches a log. */
export type WebhookIgnoreKind =
  | 'unknown_type'
  | 'thin_event'
  | 'test_mode'
  | 'unrecognized_shape'
  | 'no_ref';

/**
 * What a verified webhook hands to ingress. `eventId` is required and always derived from signed
 * content (sender event id or body digest): ingress dedupes on it, so a recipe cannot skip dedupe.
 */
export interface WebhookDelivery {
  eventId: string;
  refs: string[];
  records?: Record<string, UpstreamRecord>;
  deleted?: string[];
  /** Refs allowed to create a pass; others only update. Absent: every ref may create. */
  createRefs?: string[];
  /** Source order per ref (ms); an older record than the last applied one is skipped. */
  versions?: Record<string, number>;
  /**
   * The signed time (ms) that passed the replay window: a signed header, or the signed body's own time.
   * Ingress refuses a recipe delivery without one.
   */
  signedAt?: number;
  /** True when only the previous webhook secret verified this delivery (the sender has not switched). */
  usedPreviousSecret?: true;
  /** Set: refs is empty, the delivery is acknowledged and logged, nothing is applied. */
  ignored?: WebhookIgnoreKind;
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
  /** One line for the connector picker. */
  description?: string;
  /** Picker group. */
  category: ConnectorCategory;
  /** Position within the group; lower first. */
  order: number;
  capabilities: ConnectorCapabilities;
  /** Whether webhook refs require an embedded record or deletion instead of a source fetch.
   * This metadata does not enable webhooks when verifyWebhook is absent.
   */
  webhookReferenceMode: 'embedded-required' | 'refs-only';
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
    /** Largest response body; the default is safe-fetch's 256 KB. */
    maxResponseBytes?: number;
    /** GET redirect hops to follow (each re-checked); the default is none. */
    maxRedirects?: number;
  };
  /** Config keys that cannot change once the connection exists. */
  fixedConfig?: readonly string[];
  /** Sender recipes offered to the console; empty or absent for most connectors. */
  recipes?: readonly Omit<RecipeInfo, 'entitled'>[];
  migrate?(oldVersion: number, config: unknown): C;
  /** Every URL the connector will fetch; checked against the SSRF rules at save time. */
  urls?(config: C): string[];
  /**
   * The only origins `ctx.fetch` may reach; any other URL throws OFF_ORIGIN before DNS. `[]` means no
   * egress at all. Absent leaves the fetch unpinned (each URL and hop still passes safe-fetch).
   */
  egress?(config: C): string[];
  /** Fills create-time values (such as a date anchor) once, before a new connection's config is stored. */
  prepareConfig?(
    config: C,
    context: {
      now: number;
      /** The org's zone, so a stamped date is the org's local date. */
      timeZone: string;
      /** The stored config on an update: a value the caller left out keeps it. */
      previous?: C;
    },
  ): C;
  /** False when listChanges is not usable for this config; the core then fetches per pass. Default: true if listChanges exists. */
  hasList?(config: C): boolean;

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
  verifyWebhook?(ctx: ConnectorContext<C, S>, req: Request): Promise<WebhookDelivery>;
  importRecords?(
    ctx: ConnectorContext<C, S>,
    cursor: string | null,
  ): Promise<{
    records: { ref: string; record: UpstreamRecord; holderEmail?: string }[];
    cursor: string | null;
  }>;
}

/** A finer cause inside a code, for the probe and logs. A closed list: upstream text never reaches it. */
export type ConnectorErrorReason = 'OFF_ORIGIN';

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
  readonly reason?: ConnectorErrorReason;
  constructor(
    code: ConnectorErrorCode,
    options: {
      permanent?: boolean;
      retryAfterMs?: number;
      httpStatus?: number;
      reason?: ConnectorErrorReason;
    } = {},
  ) {
    super(code);
    this.name = 'ConnectorError';
    this.code = code;
    this.permanent = options.permanent ?? false;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.reason !== undefined) this.reason = options.reason;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: registries hold connectors of differing config and secret types
export type AnyConnector = ConnectorDefinition<any, any>;
