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

/** What an exit at an event place leaves, for the proof that follows the pass past its deletion. */
export interface MarkOutEffect {
  gateAfter: Record<string, string | number | null>;
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

/**
 * The check-in gate (unchanged by an exit) and the presence row the exit writes, from the rows the desk
 * read. Null unless the place is an event and the gate's last scan has a ledger row naming its action.
 */
export async function markOutEffect(
  db: D1Database,
  s: Pick<MarkOutScan, 'id' | 'passId' | 'templateId' | 'place'>,
  orgId: string,
  mode: string,
): Promise<MarkOutEffect | null> {
  if (!s.place.startsWith('event:')) return null;
  const held = await first<Held>(
    db,
    `SELECT state, tracking, entered_at AS enteredAt, first_at AS firstAt, last_entry_at AS lastEntryAt,
       last_scan_id AS lastScanId FROM scan_presence WHERE org_id = ? AND pass_id = ? AND scope = ?`,
    [orgId, s.passId, s.place],
  );
  if (!held) return null;
  // The newest check-in gate of the pass: after an undo it is the undo row's, which names the action
  // in its signed post-undo gate.
  const gate = await first<Record<string, string | number | null>>(
    db,
    `SELECT g.scope, g.kind, g.state, g.count, g.first_at AS firstAt, g.last_at AS lastAt,
       g.last_scan_id AS lastScanId, g.prev_state AS prevState, g.prev_last_at AS prevLastAt,
       g.prev_scan_id AS prevScanId,
       (SELECT COALESCE(json_extract(e.data, '$.actionIdRef'), json_extract(e.data, '$.postUndoGate.actionIdRef'))
         FROM pass_events e WHERE e.pass_id = g.pass_id AND e.org_id = g.org_id AND e.mode = g.mode
         AND (CASE WHEN json_valid(e.data) THEN json_extract(e.data, '$.scanId') END) = g.last_scan_id
         LIMIT 1) AS actionIdRef
     FROM scan_gates g WHERE g.pass_id = ? AND g.org_id = ? AND g.mode = ? AND g.template_id = ?
       AND g.kind = 'check_in' AND g.state IN ('in', 'out')
       AND (g.scope = ? OR g.scope = '' OR g.scope GLOB 'day:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
     ORDER BY g.last_at DESC, g.last_scan_id DESC LIMIT 1`,
    [s.passId, orgId, mode, s.templateId, s.place],
  );
  if (!gate?.actionIdRef) return null;
  return {
    gateAfter: { passId: s.passId, orgId, mode, templateId: s.templateId, ...gate },
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
