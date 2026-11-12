import { beforeAll, describe, expect, it } from 'vitest';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import { createIds } from '../../platform/ids.ts';
import type { Pass } from '../passes/repo.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

const ACTION = 'migration-retention-check-in';
let kit: ScanKit;
let templateId: string;

beforeAll(async () => {
  kit = await setupScanKit();
  kit.clock.set(Date.UTC(2026, 0, 1, 12));
  templateId = await kit.scanTemplate('Retention migration', {
    actions: [{ id: ACTION, label: 'Entry', kind: 'check_in', repeat: 'always' }],
  });
});

async function scan(headers: Record<string, string>, pass: Pass): Promise<string> {
  const response = await kit.post(headers, '/actions', {
    idempotencyKey: key(),
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId: ACTION,
  });
  expect(response.status).toBe(200);
  const result = ScanOutcomeSchema.parse(await response.json());
  expect(result.kind).toBe('ok');
  if (!result.scanId) throw new Error('Missing completed scan');
  return result.scanId;
}

/** Model an event-scoped successful transition that has no signed proof. */
async function cloneCompletedScan(scanId: string): Promise<string> {
  const clone = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO scans
    (id,org_id,mode,pass_id,template_id,scanner_id,event_id,actor_type,actor_id,actor_key,staff_id,
     approved_by,idempotency_key,request_hash,method,state,outcome,reason,action_id,action_kind,
     direction,pass_version,at,presence_scope)
    SELECT ?,org_id,mode,pass_id,template_id,scanner_id,event_id,actor_type,actor_id,actor_key,staff_id,
     approved_by,?,request_hash,method,state,outcome,reason,action_id,action_kind,
     direction,pass_version,at,presence_scope FROM scans WHERE id=?`,
    [clone, key(), scanId],
  );
  return clone;
}

async function stage(scanId: string): Promise<void> {
  await run(
    kit.env.DB,
    `INSERT INTO scan_retention_delete_intents (scan_id,org_id,mode,pass_ref)
    SELECT scan_id,org_id,mode,pass_ref FROM scan_retention_proofs WHERE scan_id=?`,
    [scanId],
  );
}

async function restorePresence(passId: string, eventId: string, snapshot: string): Promise<void> {
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

describe('scan retention migration authority', () => {
  it('keeps commit-order transitions immutable until their owning scan is deleted', async () => {
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: event.id });
    const pass = await kit.scanPass(templateId);
    const scanId = await scan(scanner.headers, pass);
    const transition = await first<{ sequence: number; scan_id: string }>(
      kit.env.DB,
      'SELECT sequence,scan_id FROM scan_retention_event_transitions WHERE scan_id=?',
      [scanId],
    );
    if (!transition) throw new Error('Missing committed event transition');

    await expect(
      run(
        kit.env.DB,
        'UPDATE scan_retention_event_transitions SET sequence=sequence+10000000 WHERE scan_id=?',
        [scanId],
      ),
    ).rejects.toThrow();
    await expect(
      run(kit.env.DB, 'DELETE FROM scan_retention_event_transitions WHERE scan_id=?', [scanId]),
    ).rejects.toThrow();
    await expect(
      run(
        kit.env.DB,
        `INSERT OR REPLACE INTO scan_retention_event_transitions
      (sequence,scan_id,org_id,mode,event_id,pass_ref)
      SELECT sequence,scan_id,org_id,mode,event_id,NULL FROM scan_retention_event_transitions WHERE scan_id=?`,
        [scanId],
      ),
    ).rejects.toThrow();
    expect(
      await first(
        kit.env.DB,
        'SELECT sequence,scan_id FROM scan_retention_event_transitions WHERE scan_id=?',
        [scanId],
      ),
    ).toEqual(transition);
    await run(kit.env.DB, 'DELETE FROM scans WHERE id=?', [scanId]);
    expect(
      await first(
        kit.env.DB,
        'SELECT sequence FROM scan_retention_event_transitions WHERE scan_id=?',
        [scanId],
      ),
    ).toBeNull();
  });

  it.each(['unlink', 'delete'] as const)(
    'latches older occupancy but preserves its receipt when a later unsigned transition is removed by %s',
    async (operation) => {
      const event = await kit.event({ templateIds: [templateId] });
      const scanner = await kit.scanner({ eventId: event.id });
      const pass = await kit.scanPass(templateId);
      const older = await scan(scanner.headers, pass);
      const later = await cloneCompletedScan(older);
      expect(
        await first(
          kit.env.DB,
          'SELECT pass_ref FROM scan_retention_event_transitions WHERE scan_id=?',
          [later],
        ),
      ).toEqual({ pass_ref: null });
      if (operation === 'unlink')
        await run(kit.env.DB, 'UPDATE scans SET pass_id=NULL WHERE id=?', [later]);
      else await run(kit.env.DB, 'DELETE FROM scans WHERE id=?', [later]);
      expect(
        await first(
          kit.env.DB,
          'SELECT invalidated,occupancy_invalidated FROM scan_retention_proofs WHERE scan_id=?',
          [older],
        ),
      ).toEqual({ invalidated: 0, occupancy_invalidated: 1 });
    },
  );

  it('uses committed event order when same-millisecond scan identifiers sort in reverse', async () => {
    const eventA = await kit.event({ templateIds: [templateId] });
    const eventB = await kit.event({ templateIds: [templateId] });
    const scannerA = await kit.scanner({ eventId: eventA.id });
    const scannerB = await kit.scanner({ eventId: eventB.id });
    const pass = await kit.scanPass(templateId);
    const ids = createIds(kit.clock);
    for (let i = 0; i < 64; i++) ids.ordered();
    const older = await scan(scannerA.headers, pass);
    // Simulate another isolate issuing an independently ordered UUID in the same millisecond.
    ids.ordered(kit.clock.now() + 1);
    const latest = await scan(scannerA.headers, pass);
    expect(older > latest).toBe(true);
    const otherEvent = await scan(scannerB.headers, pass);
    const proofs = await all<{ scan_id: string; pass_ref: string; presence_snapshot: string }>(
      kit.env.DB,
      'SELECT scan_id,pass_ref,presence_snapshot FROM scan_retention_proofs WHERE scan_id IN (?,?)',
      [older, latest],
    );
    const oldProof = proofs.find((proof) => proof.scan_id === older);
    const newProof = proofs.find((proof) => proof.scan_id === latest);
    if (!oldProof?.presence_snapshot || !newProof?.presence_snapshot)
      throw new Error('Missing signed event presence');
    await stage(latest);

    // Reverting live presence to an authentic older snapshot must not revive that snapshot.
    await restorePresence(pass.id, eventA.id, oldProof.presence_snapshot);
    const oldSnapshot: unknown = JSON.parse(oldProof.presence_snapshot);
    if (
      typeof oldSnapshot !== 'object' ||
      oldSnapshot === null ||
      !('state' in oldSnapshot) ||
      (oldSnapshot.state !== 'in' && oldSnapshot.state !== 'out')
    )
      throw new Error('Invalid signed presence state');
    const oldState = oldSnapshot.state;
    await expect(
      run(
        kit.env.DB,
        `INSERT INTO scan_retained_gates
      (scan_id,org_id,mode,event_id,pass_ref,state,presence_state) VALUES (?,?,'live',?,?,?,?)`,
        [older, kit.org.id, eventA.id, oldProof.pass_ref, oldState, oldState],
      ),
    ).rejects.toThrow();

    await restorePresence(pass.id, eventA.id, newProof.presence_snapshot);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id=?', [pass.id]);
    await run(kit.env.DB, 'DELETE FROM scan_retention_delete_intents WHERE scan_id=?', [latest]);
    const retained = await all<{ scan_id: string; event_id: string }>(
      kit.env.DB,
      'SELECT scan_id,event_id FROM scan_retained_gates WHERE scan_id IN (?,?,?) ORDER BY event_id',
      [older, latest, otherEvent],
    );
    expect(retained).toHaveLength(2);
    expect(retained).toEqual(
      expect.arrayContaining([
        { scan_id: latest, event_id: eventA.id },
        { scan_id: otherEvent, event_id: eventB.id },
      ]),
    );
  });
});
