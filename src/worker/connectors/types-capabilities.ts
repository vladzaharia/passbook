import type { z } from 'zod';
import type { SubscribableEventTypeSchema } from '../../shared/contracts/webhooks-events.ts';

/** Where records come from. `delta` needs `list`; `fetch` is one record by ref. */
export interface ReadCapabilities {
  fetch?: true;
  list?: true;
  delta?: true;
  import?: true;
  /** Records come from uploaded files, read through `ctx.files`. */
  upload?: true;
}

export type WriteOpKind = 'create' | 'update' | 'delete';

/** `managed`: the connector registers, renews and unregisters its vendor webhooks itself. */
export type InboundWebhook = 'none' | 'manual' | 'managed';

export type ConnectorAuth = 'none' | 'secret' | 'oauth2';

export type OutboundEventKind = z.infer<typeof SubscribableEventTypeSchema>;

/** What a connector declares. The registry refuses one that does not match the methods present. */
export interface DeclaredCapabilities {
  read?: ReadCapabilities;
  /** Objects the connector writes upstream, with the ops it performs on each. */
  write?: { objects: Readonly<Record<string, readonly WriteOpKind[]>> };
  inbound?: { webhook: InboundWebhook };
  /** Event kinds this connector consumes from the outbound feed. */
  outbound?: { events: readonly OutboundEventKind[] };
  auth: ConnectorAuth;
}

/** The v1 flags the core still reads, derived from the declaration by `declareCapabilities`. */
export interface LegacyCapabilityFlags {
  poll?: true;
  delta?: true;
  webhook?: true;
  import?: true;
  snapshot?: true;
  upload?: true;
}

export type ConnectorCapabilities = DeclaredCapabilities & LegacyCapabilityFlags;

export function legacyFlags(declared: DeclaredCapabilities): LegacyCapabilityFlags {
  const read = declared.read ?? {};
  const flags: LegacyCapabilityFlags = {};
  if (read.list) flags.poll = true;
  if (read.delta) flags.delta = true;
  if ((declared.inbound?.webhook ?? 'none') !== 'none') flags.webhook = true;
  if (read.import) flags.import = true;
  if (read.upload) flags.upload = true;
  return flags;
}

export function declareCapabilities(declared: DeclaredCapabilities): ConnectorCapabilities {
  return { ...declared, ...legacyFlags(declared) };
}

/** `in`: upstream to us; `out`: us to upstream; `both` names a master that wins a conflict. */
export type FieldDirection = 'in' | 'out' | 'both';

export interface CatalogField {
  type: 'string' | 'number' | 'boolean' | 'date';
  direction: FieldDirection;
  /** Required for `both`: the side that wins when both changed. */
  master?: 'local' | 'remote';
}

/** Upstream objects the connector knows, keyed by object name. */
export type ObjectCatalog = Readonly<
  Record<string, { label: string; fields: Readonly<Record<string, CatalogField>> }>
>;
