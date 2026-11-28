import type { Json } from '../../shared/contracts/common.ts';
import type { OutboundEventKind, WriteOpKind } from './types-capabilities.ts';

/** One event from the outbound feed, as a connector sees it. */
export interface OutboundEvent {
  id: string;
  type: OutboundEventKind;
  occurredAt: number;
  passId: string | null;
  data: Readonly<Record<string, Json>>;
}

/** A pass's link to an upstream object. A deleted upstream object leaves the link `tombstoned`. */
export interface ConnectorLink {
  object: string;
  externalId: string;
  state: 'active' | 'tombstoned';
  /** Mirrors `passes.connection_id/external_ref`. */
  primary: boolean;
}

export interface WriteOp {
  object: string;
  kind: WriteOpKind;
  /** Absent only for `create`. */
  externalId?: string;
  fields: Readonly<Record<string, Json>>;
}

/** A write op as the core queues it; `opId` goes into a vendor field where one exists, to break loops. */
export interface QueuedWriteOp extends WriteOp {
  opId: string;
  attempt: number;
}

export type WriteResult =
  | { status: 'ok'; externalId: string; version?: string }
  | { status: 'not_found' };

/** Writing upstream. Both or neither; declared in `capabilities.write` and `capabilities.outbound`. */
export interface ConnectorWrite<Ctx> {
  /** Pure: what to write for this event. An empty list writes nothing. */
  mapEvent?(ctx: Ctx, event: OutboundEvent, link: ConnectorLink | null): WriteOp[];
  /** Throws ConnectorError on failure; AUTH and TIMEOUT never alter passes. */
  write?(ctx: Ctx, op: QueuedWriteOp): Promise<WriteResult>;
}
