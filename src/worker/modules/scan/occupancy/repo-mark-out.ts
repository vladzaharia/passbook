// Mark as out (SA §20.9): the exit's scans row, written in the exit's own batch and only if the exit won.
import type { Grant, GrantedStatement } from '../../../platform/authority.ts';
import type { GrantCond } from '../../../platform/authority-cond.ts';

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
