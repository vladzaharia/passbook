import {
  credentialAad,
  decryptSecretText,
  type Envelope,
  encryptSecret,
  type KekRing,
  loadKekRing,
} from '../../platform/crypto.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import {
  commitLegacyInbox,
  type LegacyInboxCommit,
  type LegacyInboxRead,
  type LegacyInboxRow,
  readLegacyInbox,
} from './repo-legacy-inbox.ts';
import type { InboxItem } from './repo-pass-inbox.ts';

const aad = (id: string, orgId: string) =>
  credentialAad(id, orgId, 'connection.webhook.legacy-inbox');
const missing = () =>
  new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
const changed = () =>
  new UnavailableError('The webhook work changed. Retry later.', 'WEBHOOK_WORK_CHANGED');

export interface LegacyKeySnapshot {
  env: Readonly<Record<string, string>>;
  commitment: string;
}

function isRow(value: unknown): value is LegacyInboxRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.ref === 'string' &&
    (typeof row.record === 'string' || row.record === null) &&
    (row.deleted === 0 || row.deleted === 1) &&
    Number.isSafeInteger(row.receivedAt)
  );
}

export function parseRecord(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  const record: unknown = JSON.parse(text);
  if (record === null) return null;
  if (typeof record !== 'object' || Array.isArray(record)) throw missing();

  // JSON numbers outside JavaScript's finite range cannot survive staging unchanged.
  const values: unknown[] = [record];
  while (values.length) {
    const value = values.pop();
    if (typeof value === 'number' && !Number.isFinite(value)) throw missing();
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) values.push(child);
    }
  }
  return record as Record<string, unknown>;
}

/** Compare JSON values without treating object-key order as a payload conflict. */
function sameRecord(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null,
): boolean {
  const pairs: Array<readonly [unknown, unknown]> = [[left, right]];
  while (pairs.length) {
    const [a, b] = pairs.pop() as readonly [unknown, unknown];
    if (a === b) continue;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
    const aa = a as Record<string, unknown>;
    const bb = b as Record<string, unknown>;
    const keys = Object.keys(aa);
    if (keys.length !== Object.keys(bb).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(bb, key)) return false;
      pairs.push([aa[key], bb[key]]);
    }
  }
  return true;
}

/**
 * Seal all currently observed legacy rows before exposing their items for chunk staging.
 * This preserves payloads only; it does not establish an original release or execution authority.
 */
export async function sealLegacyWebhookInbox(
  sctx: ServiceContext,
  connectionId: string,
  orgId: string,
  eventId: string,
  keys?: LegacyKeySnapshot,
): Promise<InboxItem[]> {
  return (await sealInbox(sctx, connectionId, orgId, eventId, false, keys)).items;
}

export async function sealLegacyInboxForCleanup(
  sctx: ServiceContext,
  connectionId: string,
  orgId: string,
  eventId: string,
  keys?: LegacyKeySnapshot,
): Promise<{ items: InboxItem[]; observed: LegacyInboxRead }> {
  return sealInbox(sctx, connectionId, orgId, eventId, true, keys);
}

async function sealInbox(
  sctx: ServiceContext,
  connectionId: string,
  orgId: string,
  eventId: string,
  retainPlaintext: boolean,
  keys?: LegacyKeySnapshot,
): Promise<{ items: InboxItem[]; observed: LegacyInboxRead }> {
  const keyEnv = keys?.env ?? captureCredentialKeyEnv(sctx.env);
  const commitment = await requireCredentialRefKeyset(sctx.env.DB, keyEnv);
  if (keys && keys.commitment !== commitment) {
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  }
  let observed: LegacyInboxRead | null;
  try {
    observed = await readLegacyInbox(sctx.env.DB, connectionId, orgId, eventId);
  } catch {
    throw changed();
  }
  if (!observed) throw missing();

  let ring: KekRing | undefined;
  let source: { id: string; envelope: Envelope; receivedAt: number } | null = null;
  if (observed.rows.length) {
    try {
      ring = await loadKekRing(keyEnv);
      const id = sctx.ids.id();
      source = {
        id,
        envelope: await encryptSecret(
          ring,
          JSON.stringify({
            version: 1,
            connectionId,
            eventId,
            eventReceivedAt: observed.receivedAt,
            rows: observed.rows,
          }),
          aad(id, orgId),
        ),
        receivedAt: sctx.clock.now(),
      };
    } catch {
      throw new UnavailableError('Could not retain the webhook.', 'WEBHOOK_RETENTION_FAILED');
    }
  }

  let result: LegacyInboxCommit;
  try {
    result = await commitLegacyInbox(
      sctx,
      connectionId,
      orgId,
      eventId,
      observed,
      source,
      retainPlaintext,
    );
  } catch {
    throw changed();
  }
  if (result.status === 'missing') throw missing();
  if (result.status === 'changed') throw changed();
  if (!result.sources.length) return { items: [], observed };

  // Open every source, including the one just committed. Conflicts or unreadable sources
  // leave all encrypted copies intact and are never resolved by choosing a newer value.
  try {
    ring ??= await loadKekRing(keyEnv);
    const items = new Map<string, InboxItem>();
    for (const stored of result.sources) {
      if (stored.orgId !== orgId) throw missing();
      const text = await decryptSecretText(ring, stored.envelope, aad(stored.id, orgId));
      const payload: unknown = JSON.parse(text);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw missing();
      const data = payload as {
        version?: unknown;
        connectionId?: unknown;
        eventId?: unknown;
        eventReceivedAt?: unknown;
        rows?: unknown;
      };
      if (
        data.version !== 1 ||
        data.connectionId !== connectionId ||
        data.eventId !== eventId ||
        data.eventReceivedAt !== observed.receivedAt ||
        !Array.isArray(data.rows) ||
        !data.rows.every(isRow)
      )
        throw missing();
      for (const row of data.rows) {
        const item: InboxItem = {
          ref: row.ref,
          record: parseRecord(row.record),
          deleted: row.deleted === 1,
        };
        const previous = items.get(item.ref);
        if (
          previous &&
          (previous.deleted !== item.deleted || !sameRecord(previous.record, item.record))
        ) {
          throw missing();
        }
        if (!previous) items.set(item.ref, item);
      }
    }
    return { items: [...items.values()], observed };
  } catch {
    throw missing();
  }
}
