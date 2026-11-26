import type { Json, Mode } from '../../../shared/contracts/common.ts';
import {
  type EventActorType,
  type EventKind,
  EventKindSchema,
} from '../../../shared/contracts/events.ts';
import { batch, chunk } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type EventRow, insertEventStmt, passExists } from './repo.ts';

export interface PassEventInput {
  orgId: string;
  passId: string;
  mode: Mode;
  kind: EventKind;
  /** The raw Wallet device library identifier. It is hashed here and never stored. */
  device?: string | null;
  /** An already hashed device (see hashDevice), for events attributed after the fact. */
  deviceHash?: string | null;
  actor?: { type: EventActorType; id: string | null } | null;
  data?: Record<string, Json>;
  /** Defaults to now. */
  at?: number;
  /** Defaults to a new ordered id; set by callers that report the id back. */
  id?: string;
}

const DATA_MAX_BYTES = 2048;
const DEVICE_HASH_LENGTH = 12;
/** Keys that would carry emails, tokens, push tokens or personalization values. */
const FORBIDDEN_KEY =
  /(email|token|secret|password|authorization|cookie|personali[sz]|pushtoken|credential)/i;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/;

/** First 12 hex characters of SHA-256(device id): enough to tell devices apart, not to find one. */
export async function hashDevice(deviceId: string): Promise<string> {
  return (await sha256Hex(deviceId)).slice(0, DEVICE_HASH_LENGTH);
}

function scrub(value: Json, depth = 0): Json | undefined {
  if (typeof value === 'string') return EMAIL_LIKE.test(value) ? undefined : value.slice(0, 300);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 3) return undefined;
  if (Array.isArray(value))
    return value.slice(0, 20).flatMap((v) => {
      const kept = scrub(v, depth + 1);
      return kept === undefined ? [] : [kept];
    });
  const out: Record<string, Json> = {};
  for (const [key, v] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    const kept = scrub(v, depth + 1);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

/** Drops forbidden keys and email-like strings, and caps the stored size. */
export function sanitizeEventData(data: Record<string, Json> | undefined): Record<string, Json> {
  const clean = (scrub(data ?? {}) ?? {}) as Record<string, Json>;
  return JSON.stringify(clean).length > DATA_MAX_BYTES ? { truncated: true } : clean;
}

/** The one row shape: kind check, actor and redacted data. `at` is required here. */
export function eventRowOf(
  input: PassEventInput & { at: number },
  id: string,
  device: string | null,
): EventRow {
  return {
    id,
    org_id: input.orgId,
    pass_id: input.passId,
    mode: input.mode,
    kind: EventKindSchema.parse(input.kind),
    device,
    actor_type: input.actor?.type ?? null,
    actor_id: input.actor?.id ?? null,
    data: JSON.stringify(sanitizeEventData(input.data)),
    at: input.at,
  };
}

async function toRow(ctx: ServiceContext, input: PassEventInput): Promise<EventRow> {
  const at = input.at ?? ctx.clock.now();
  const device = input.device ? await hashDevice(input.device) : (input.deviceHash ?? null);
  // The API request that caused the event, so webhooks and the request log can be read together.
  const data = ctx.requestId ? { ...input.data, requestId: ctx.requestId } : input.data;
  return eventRowOf({ ...input, data, at }, input.id ?? ctx.ids.ordered(at), device);
}

/**
 * Appends events to the ledger. Never throws: the ledger is a record of what happened, so a failed
 * write is logged (events.record_failed) and must not fail the action it describes.
 */
export async function recordPassEvents(
  ctx: ServiceContext,
  inputs: readonly PassEventInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  try {
    const rows = await Promise.all(inputs.map((input) => toRow(ctx, input)));
    // Ids are UUIDv7 from one clock, so a batch keeps its order within the same millisecond.
    for (const part of chunk(rows, 50)) {
      const results = await batch(
        ctx.env.DB,
        part.map((row) => insertEventStmt(ctx.env.DB, row)),
      );
      for (const [index, result] of results.entries()) {
        const row = part[index];
        // The event feed trigger (0090) adds its own row to `changes`: only 0 means refused.
        if (result.meta.changes > 0 || !row) continue;
        const missing = !(await passExists(ctx.env.DB, row.pass_id));
        ctx.log.error(missing ? 'events.pass_missing' : 'events.org_mismatch', {
          code: missing ? 'EVENT_PASS_MISSING' : 'EVENT_ORG_MISMATCH',
          orgId: row.org_id,
          passId: row.pass_id,
          kind: row.kind,
        });
      }
    }
  } catch (error) {
    ctx.log.error('events.record_failed', {
      code: 'EVENT_RECORD_FAILED',
      count: inputs.length,
      kind: inputs[0]?.kind,
      passId: inputs[0]?.passId,
      error,
    });
  }
}

export function recordPassEvent(ctx: ServiceContext, input: PassEventInput): Promise<void> {
  return recordPassEvents(ctx, [input]);
}
