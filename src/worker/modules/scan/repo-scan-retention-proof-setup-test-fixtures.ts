import { expect } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run, stmt } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';
import type { Pass } from '../passes/repo-map.ts';
import {
  clearScanRetentionDeleteStmt,
  retainedEventCountSql,
  stageScanRetentionDeleteStmt,
} from './repo-scan-retention.ts';
import { prepareScanRetentionDelete } from './scan-retention-proof.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

export const ACTION = 'retention-private-action';
export const MEMBER = 'Private Retention Member';
export const EMAIL = 'private-retention@example.com';
export let kit: ScanKit;
export let templateId: string;

export async function setupRetentionProof() {
  kit = await setupScanKit();
  kit.clock.set(Date.UTC(2026, 0, 1, 12));
  templateId = await kit.scanTemplate('Retention proof', {
    actions: [{ id: ACTION, label: 'Entry', kind: 'check_in', repeat: 'once' }],
  });
}

export async function scenario() {
  const event = await kit.event({ templateIds: [templateId] });
  const scanner = await kit.scanner({ eventId: event.id });
  const pass = await kit.scanPass(templateId, { memberName: MEMBER }, { holderEmail: EMAIL });
  const idempotencyKey = key();
  const request = {
    idempotencyKey,
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId: ACTION,
  };
  const response = await kit.post(scanner.headers, '/actions', request);
  expect(response.status).toBe(200);
  const outcome = (await response.json()) as ScanOutcome;
  expect(outcome.kind).toBe('ok');
  if (!outcome.scanId) throw new Error('Missing scan ID');
  const eventRow = await first<EventRow>(
    kit.env.DB,
    "SELECT * FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'",
    [pass.id],
  );
  if (!eventRow) throw new Error('Missing signed event');
  return { event, scanner, pass, request, outcome, scanId: outcome.scanId, eventRow };
}

export async function scopedCount(orgId: string, eventId: string, inside = false): Promise<number> {
  const result = await first<{ n: number }>(
    kit.env.DB,
    `SELECT ${retainedEventCountSql('?', '?', '?', inside)} AS n`,
    [orgId, 'live', eventId],
  );
  return result?.n ?? 0;
}

export async function hardDelete(pass: Pass, matches = true) {
  const prepared = await prepareScanRetentionDelete(kit.env, pass);
  return kit.env.DB.batch([
    stageScanRetentionDeleteStmt(kit.env.DB, pass.id, prepared),
    stmt(kit.env.DB, `DELETE FROM passes WHERE id=? AND ${matches ? '1' : '0'} RETURNING id`, [
      pass.id,
    ]),
    clearScanRetentionDeleteStmt(kit.env.DB, prepared),
  ]);
}

export async function transition(
  headers: Record<string, string>,
  pass: Pass,
): Promise<ScanOutcome> {
  const response = await kit.post(headers, '/actions', {
    idempotencyKey: key(),
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId: ACTION,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ScanOutcome;
}

export async function restorePresence(
  passId: string,
  eventId: string,
  snapshot: string,
): Promise<void> {
  await run(
    kit.env.DB,
    `UPDATE scan_presence SET
    state=json_extract(?1,'$.state'), tracking=json_extract(?1,'$.tracking'),
    entered_at=json_extract(?1,'$.enteredAt'), first_at=json_extract(?1,'$.firstAt'),
    last_entry_at=json_extract(?1,'$.lastEntryAt'), last_scan_id=json_extract(?1,'$.lastScanId'),
    prev_state=json_extract(?1,'$.prevState'), prev_tracking=json_extract(?1,'$.prevTracking'),
    prev_entered_at=json_extract(?1,'$.prevEnteredAt'), prev_first_at=json_extract(?1,'$.prevFirstAt'),
    prev_last_entry_at=json_extract(?1,'$.prevLastEntryAt'), prev_scan_id=json_extract(?1,'$.prevScanId')
    WHERE pass_id=?2 AND scope=?3`,
    [snapshot, passId, `event:${eventId}`],
  );
}
