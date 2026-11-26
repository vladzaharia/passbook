import type { Json } from '../../../../shared/contracts/common.ts';
import type { SetupGuide } from '../../../../shared/contracts/connection-setup.ts';
import type { RecipeId, RecipeInfo } from '../../../../shared/contracts/connections.ts';
import type { UpstreamRecord, WebhookIgnoreKind } from '../../types.ts';

export const HOUR_MS = 3_600_000;
const MAX_REF = 200;

export interface RecipeConfig {
  acceptTestEvents: boolean;
  /** WooCommerce: one pass per order or per line item. */
  passPer?: 'order' | 'line_item';
}

export interface RecipeInput {
  /** Parsed from the signed bytes. */
  body: unknown;
  /** sha256 of the signed bytes: the event id of senders without one. */
  digest: string;
  now: number;
  config: RecipeConfig;
  /** An unsigned header: it may narrow what is handled, never widen it. */
  topic: string | null;
}

export interface RecipeOutcome {
  /** Overrides the digest-based id (Stripe: the event id). */
  eventId?: string;
  refs: string[];
  records: Record<string, UpstreamRecord>;
  versions: Record<string, number>;
  createRefs: string[];
  /** The signed time in the body (ms); required for a body-window verifier, which cannot read one from a header. */
  signedAt?: number;
  ignored?: WebhookIgnoreKind;
}

export interface Recipe
  extends Omit<RecipeInfo, 'id' | 'entitled' | 'line' | 'secretOrigin' | 'setupVersion'> {
  id: Exclude<RecipeId, 'custom'>;
  /** One line for the picker. */
  line: string;
  /** Who makes the signing secret. `pasteSecret` is what the service acts on today. */
  secretOrigin: 'provider' | 'passbook';
  /**
   * `account`: the sender signs every webhook of one account with one key (Shopify), so connections of the
   * same verifier family in one org may share a secret. Enforced by the secret-reuse guard.
   */
  secretScope: 'connection' | 'account';
  /** The sender's side of the setup, served by `GET /connectors/webhook-push/recipes/{recipe}/setup`. */
  setup: SetupGuide;
  verifier: 'shopify' | 'stripe' | 'calcom' | 'woocommerce' | 'tickettailor';
  /** The signed body may be something other than JSON (WooCommerce pings with a form body): adapt gets undefined. */
  tolerateNonJson?: boolean;
  /** Header whose value is passed as `topic`. */
  topicHeader: string | null;
  /** How old the signed body time may be (body-window verifiers only). */
  windowMs: number;
  /** Event id prefix for the body-digest id. */
  idPrefix: string;
  /** The subscriptions to add at the sender, for the console. */
  topics: readonly string[];
  adapt(input: RecipeInput): RecipeOutcome;
}

export const ignored = (kind: WebhookIgnoreKind): RecipeOutcome => ({
  refs: [],
  records: {},
  versions: {},
  createRefs: [],
  ignored: kind,
});

export function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** The first element of an array, when it is an object. */
export const first = (v: unknown): Record<string, unknown> | null =>
  Array.isArray(v) ? obj(v[0]) : null;

/** A non-empty string no longer than a ref may be. */
export function ref(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_REF ? v : null;
}

export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Epoch ms of an ISO-8601 string with a zone; null for anything else. */
export function isoMs(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(v))
    return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Drops absent fields; every value is JSON. */
export function record(fields: Record<string, Json | undefined>): UpstreamRecord {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as UpstreamRecord;
}
