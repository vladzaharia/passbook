// Mark as out (SA §20.9): the exit's scans row, written in the exit's own batch and only if the exit won.
import type { Grant, GrantedStatement } from '../../../platform/authority.ts';
import type { GrantCond } from '../../../platform/authority-cond.ts';
import { first } from '../../../platform/db.ts';

export interface MarkOutScan {
  id: string;
  now: number;
  passId: string;
  templateId: string;
  passVersion: number;
  place: string;
  actorType: 'scanner' | 'user';
  actorId: string;
  actorKey: string;
  scannerId: string | null;
  staffId: string | null;
  sessionId: string | null;
  apiKeyId: string | null;
  eventId: string | null;
  idempotencyKey: string;
  requestHash: string;
}

/** A finished exit (`out_cause` desk). Nothing is written when `when` fails, and a repeated key writes nothing twice. */
export function markOutScan(g: Grant, s: MarkOutScan, when: GrantCond[]): GrantedStatement {
  return g.upsert(
    'scans',
    [
      'id',
      'pass_id',
      'template_id',
      'scanner_id',
      'event_id',
      'actor_type',
      'actor_id',
      'actor_key',
      'staff_id',
      'session_id',
      'api_key_id',
      'idempotency_key',
      'request_hash',
      'method',
      'state',
      'outcome',
      'direction',
      'presence_scope',
      'out_cause',
      'pass_version',
      'at',
    ],
    [
      s.id,
      s.passId,
      s.templateId,
      s.scannerId,
      s.eventId,
      s.actorType,
      s.actorId,
      s.actorKey,
      s.staffId,
      s.sessionId,
      s.apiKeyId,
      s.idempotencyKey,
      s.requestHash,
      'manual',
      'done',
      'ok',
      'out',
      s.place,
      'desk',
      s.passVersion,
      s.now,
    ],
    { doNothing: true, when, returning: ['id'] },
  );
}

/** The presence row an exit at an event place writes, for the proof that follows the pass past its deletion. */
export interface MarkOutEffect {
  presenceAfter: Record<string, string | number | null>;
}

interface Held {
  state: string;
  tracking: number;
  enteredAt: number | null;
  firstAt: number;
  lastEntryAt: number;
  lastScanId: string;
}

/** The presence row the exit writes, from the row the desk read. Null unless the place is an event with a row. */
export async function markOutEffect(
  db: D1Database,
  s: Pick<MarkOutScan, 'id' | 'passId' | 'place'>,
  orgId: string,
): Promise<MarkOutEffect | null> {
  if (!s.place.startsWith('event:')) return null;
  const held = await first<Held>(
    db,
    `SELECT state, tracking, entered_at AS enteredAt, first_at AS firstAt, last_entry_at AS lastEntryAt,
       last_scan_id AS lastScanId FROM scan_presence WHERE org_id = ? AND pass_id = ? AND scope = ?`,
    [orgId, s.passId, s.place],
  );
  if (!held) return null;
  return {
    presenceAfter: {
      passId: s.passId,
      orgId,
      scope: s.place,
      state: 'out',
      tracking: held.tracking,
      enteredAt: null,
      firstAt: held.firstAt,
      lastEntryAt: held.lastEntryAt,
      lastScanId: s.id,
      prevState: held.state,
      prevTracking: held.tracking,
      prevEnteredAt: held.enteredAt,
      prevFirstAt: held.firstAt,
      prevLastEntryAt: held.lastEntryAt,
      prevScanId: held.lastScanId,
    },
  };
}
