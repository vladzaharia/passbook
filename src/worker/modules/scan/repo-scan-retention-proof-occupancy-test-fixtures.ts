import { expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import { readVerifiedScanRetentionProofs } from './repo-scan-retention.ts';
import {
  ACTION,
  hardDelete,
  kit,
  restorePresence,
  scenario,
  scopedCount,
  templateId,
  transition,
} from './repo-scan-retention-proof-setup-test-fixtures.ts';
import { key } from './test-kit.ts';

export function registerRetentionOccupancyTests() {
  it('never captures an altered gate as historical occupancy', async () => {
    const s = await scenario();
    await run(kit.env.DB, "UPDATE scan_gates SET state='out' WHERE pass_id=?", [s.pass.id]);
    await hardDelete(s.pass);
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_retained_gates WHERE scan_id=?', [
        s.scanId,
      ]),
    ).toBeNull();
    expect(await scopedCount(kit.org.id, s.event.id)).toBe(0);
    expect(
      (
        await readVerifiedScanRetentionProofs(kit.env.DB, kit.env, { mode: 'live' }, [s.scanId])
      ).has(s.scanId),
    ).toBe(true);
  });

  it('never captures an altered event presence as historical occupancy', async () => {
    const s = await scenario();
    await run(kit.env.DB, "UPDATE scan_presence SET state='out' WHERE pass_id=? AND scope=?", [
      s.pass.id,
      `event:${s.event.id}`,
    ]);
    await hardDelete(s.pass);
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_retained_gates WHERE scan_id=?', [
        s.scanId,
      ]),
    ).toBeNull();
    expect(await scopedCount(kit.org.id, s.event.id)).toBe(0);
    expect(
      (
        await readVerifiedScanRetentionProofs(kit.env.DB, kit.env, { mode: 'live' }, [s.scanId])
      ).has(s.scanId),
    ).toBe(true);
  });

  it.each([
    { repeat: 'always', scope: '' },
    { repeat: 'daily', scope: 'day:2026-01-01' },
  ] as const)('retains event admissions for a $repeat action gate', async ({ repeat, scope }) => {
    const template = await kit.scanTemplate(`Retained ${repeat} admission`, {
      actions: [{ id: ACTION, label: 'Entry', kind: 'check_in', repeat }],
    });
    const event = await kit.event({ templateIds: [template] });
    const scanner = await kit.scanner({ eventId: event.id });
    const pass = await kit.scanPass(template);
    const result = await transition(scanner.headers, pass);
    expect(result.kind).toBe('ok');
    if (!result.scanId) throw new Error('Missing event admission');
    expect(
      await first(kit.env.DB, 'SELECT scope FROM scan_gates WHERE pass_id=?', [pass.id]),
    ).toEqual({ scope });
    expect(
      await first(kit.env.DB, 'SELECT scope,state FROM scan_presence WHERE pass_id=?', [pass.id]),
    ).toEqual({ scope: `event:${event.id}`, state: 'in' });
    const proof = await first<{ gate_snapshot: string | null; presence_snapshot: string | null }>(
      kit.env.DB,
      'SELECT gate_snapshot,presence_snapshot FROM scan_retention_proofs WHERE scan_id=?',
      [result.scanId],
    );
    expect(proof?.gate_snapshot).not.toBeNull();
    expect(proof?.presence_snapshot).not.toBeNull();
    await hardDelete(pass);
    expect(await scopedCount(kit.org.id, event.id)).toBe(1);
    expect(await scopedCount(kit.org.id, event.id, true)).toBe(1);
    expect(
      (
        await readVerifiedScanRetentionProofs(kit.env.DB, kit.env, { mode: 'live' }, [
          result.scanId,
        ])
      ).has(result.scanId),
    ).toBe(true);
  });

  it('retains independent event presences when an always gate moves to another event', async () => {
    const template = await kit.scanTemplate('Shared action gate', {
      actions: [{ id: ACTION, label: 'Entry', kind: 'check_in', repeat: 'always' }],
    });
    const a = await kit.event({ templateIds: [template] });
    const b = await kit.event({ templateIds: [template] });
    const scannerA = await kit.scanner({ eventId: a.id });
    const scannerB = await kit.scanner({ eventId: b.id });
    const pass = await kit.scanPass(template);
    const firstScan = await transition(scannerA.headers, pass);
    const secondScan = await transition(scannerB.headers, pass);
    expect(firstScan.kind).toBe('ok');
    expect(secondScan.kind).toBe('ok');
    if (!firstScan.scanId || !secondScan.scanId) throw new Error('Missing event scans');
    expect(
      await first(kit.env.DB, 'SELECT scope,last_scan_id FROM scan_gates WHERE pass_id=?', [
        pass.id,
      ]),
    ).toEqual({ scope: '', last_scan_id: secondScan.scanId });
    await hardDelete(pass);
    expect(await scopedCount(kit.org.id, a.id)).toBe(1);
    expect(await scopedCount(kit.org.id, a.id, true)).toBe(1);
    expect(await scopedCount(kit.org.id, b.id)).toBe(1);
    expect(await scopedCount(kit.org.id, b.id, true)).toBe(1);
    expect(
      await all(kit.env.DB, 'SELECT scan_id FROM scan_retained_gates WHERE scan_id IN (?,?)', [
        firstScan.scanId,
        secondScan.scanId,
      ]),
    ).toHaveLength(2);
  });

  it('orders committed event transitions independently of scan claim timestamps', async () => {
    const baseline = kit.clock.now();
    const template = await kit.scanTemplate('Commit-order event transition', {
      actions: [{ id: ACTION, label: 'Entry', kind: 'check_in', repeat: 'always' }],
    });
    const event = await kit.event({ templateIds: [template] });
    const scanner = await kit.scanner({ eventId: event.id });
    const pass = await kit.scanPass(template);
    try {
      kit.clock.set(baseline + 1000);
      const earlierCommit = await transition(scanner.headers, pass);
      kit.clock.set(baseline);
      const laterCommit = await transition(scanner.headers, pass);
      if (!earlierCommit.scanId || !laterCommit.scanId) throw new Error('Missing event scans');
      const transitions = await all<{ scan_id: string; at: number; sequence: number }>(
        kit.env.DB,
        `SELECT s.id AS scan_id,s.at,t.sequence FROM scans s JOIN scan_retention_event_transitions t ON t.scan_id=s.id
         WHERE s.id IN (?,?) ORDER BY t.sequence`,
        [earlierCommit.scanId, laterCommit.scanId],
      );
      expect(transitions).toHaveLength(2);
      expect(transitions[0]?.scan_id).toBe(earlierCommit.scanId);
      expect(transitions[1]?.scan_id).toBe(laterCommit.scanId);
      const earlierTransition = transitions[0];
      const laterTransition = transitions[1];
      if (!earlierTransition || !laterTransition) throw new Error('Missing event transitions');
      expect(earlierTransition.at).toBeGreaterThan(laterTransition.at);
      await hardDelete(pass);
      expect(await scopedCount(kit.org.id, event.id)).toBe(1);
      expect(
        await first(kit.env.DB, 'SELECT scan_id FROM scan_retained_gates WHERE scan_id=?', [
          laterCommit.scanId,
        ]),
      ).toEqual({ scan_id: laterCommit.scanId });
    } finally {
      kit.clock.set(baseline);
    }
  });

  it('does not revive a superseded signed event presence after a later admission', async () => {
    const template = await kit.scanTemplate('Latest event transition', {
      actions: [{ id: ACTION, label: 'Entry', kind: 'check_in', repeat: 'always' }],
    });
    const event = await kit.event({ templateIds: [template] });
    const scanner = await kit.scanner({ eventId: event.id });
    const pass = await kit.scanPass(template);
    const older = await transition(scanner.headers, pass);
    const latest = await transition(scanner.headers, pass);
    if (!older.scanId || !latest.scanId) throw new Error('Missing event scans');
    const proof = await first<{ presence_snapshot: string }>(
      kit.env.DB,
      'SELECT presence_snapshot FROM scan_retention_proofs WHERE scan_id=?',
      [older.scanId],
    );
    if (!proof?.presence_snapshot) throw new Error('Missing recorded presence');
    await restorePresence(pass.id, event.id, proof.presence_snapshot);
    await hardDelete(pass);
    expect(await scopedCount(kit.org.id, event.id)).toBe(0);
    expect(
      await all(kit.env.DB, 'SELECT scan_id FROM scan_retained_gates WHERE scan_id IN (?,?)', [
        older.scanId,
        latest.scanId,
      ]),
    ).toEqual([]);
  });

  it('does not revive an older occupancy when a newer signed scan is removed', async () => {
    const template = await kit.scanTemplate('Removed latest event transition', {
      actions: [{ id: ACTION, label: 'Entry', kind: 'check_in', repeat: 'always' }],
    });
    const event = await kit.event({ templateIds: [template] });
    const scanner = await kit.scanner({ eventId: event.id });
    const pass = await kit.scanPass(template);
    const older = await transition(scanner.headers, pass);
    const latest = await transition(scanner.headers, pass);
    if (!older.scanId || !latest.scanId) throw new Error('Missing event scans');
    const proof = await first<{ presence_snapshot: string }>(
      kit.env.DB,
      'SELECT presence_snapshot FROM scan_retention_proofs WHERE scan_id=?',
      [older.scanId],
    );
    if (!proof?.presence_snapshot) throw new Error('Missing recorded presence');
    await run(kit.env.DB, 'DELETE FROM scans WHERE id=?', [latest.scanId]);
    expect(
      await first(
        kit.env.DB,
        'SELECT invalidated,occupancy_invalidated FROM scan_retention_proofs WHERE scan_id=?',
        [older.scanId],
      ),
    ).toEqual({ invalidated: 0, occupancy_invalidated: 1 });
    await expect(
      run(kit.env.DB, 'UPDATE scan_retention_proofs SET occupancy_invalidated=0 WHERE scan_id=?', [
        older.scanId,
      ]),
    ).rejects.toThrow();
    await restorePresence(pass.id, event.id, proof.presence_snapshot);
    await hardDelete(pass);
    expect(await scopedCount(kit.org.id, event.id)).toBe(0);
    expect(
      (
        await readVerifiedScanRetentionProofs(kit.env.DB, kit.env, { mode: 'live' }, [older.scanId])
      ).has(older.scanId),
    ).toBe(true);
  });

  it('copies the signed current in/out presence rather than an earlier gate state', async () => {
    const event = await kit.event({ templateIds: [templateId] });
    await run(kit.env.DB, 'UPDATE scan_events SET reentry=1 WHERE id=?', [event.id]);
    const scanner = await kit.scanner({
      eventId: event.id,
      settings: { checkIn: { mode: 'in_out' }, direction: 'both' },
    });
    const pass = await kit.scanPass(templateId);
    const entry = await transition(scanner.headers, pass);
    const exit = await transition(scanner.headers, pass);
    expect(entry.checkIn).toMatchObject({ direction: 'in', inside: true });
    expect(exit.checkIn).toMatchObject({ direction: 'out', inside: false });
    if (!exit.scanId) throw new Error('Missing exit scan');
    await hardDelete(pass);
    expect(
      await first(
        kit.env.DB,
        'SELECT state,presence_state FROM scan_retained_gates WHERE scan_id=?',
        [exit.scanId],
      ),
    ).toEqual({ state: 'out', presence_state: 'out' });
    expect(await scopedCount(kit.org.id, event.id)).toBe(1);
    expect(await scopedCount(kit.org.id, event.id, true)).toBe(0);
  });

  it('retains the final authenticated re-entry and not the prior exit', async () => {
    const event = await kit.event({ templateIds: [templateId] });
    await run(kit.env.DB, 'UPDATE scan_events SET reentry=1 WHERE id=?', [event.id]);
    const scanner = await kit.scanner({
      eventId: event.id,
      settings: { checkIn: { mode: 'in_out' }, direction: 'both' },
    });
    const pass = await kit.scanPass(templateId);
    expect((await transition(scanner.headers, pass)).checkIn?.direction).toBe('in');
    expect((await transition(scanner.headers, pass)).checkIn?.direction).toBe('out');
    const reentry = await transition(scanner.headers, pass);
    expect(reentry.checkIn?.direction).toBe('in');
    if (!reentry.scanId) throw new Error('Missing re-entry scan');
    await hardDelete(pass);
    expect(
      await first(
        kit.env.DB,
        'SELECT state,presence_state FROM scan_retained_gates WHERE scan_id=?',
        [reentry.scanId],
      ),
    ).toEqual({ state: 'in', presence_state: 'in' });
    expect(await scopedCount(kit.org.id, event.id)).toBe(1);
    expect(await scopedCount(kit.org.id, event.id, true)).toBe(1);
  });

  it('captures the entry whose state an undo restored, not the unsigned undo row', async () => {
    const event = await kit.event({ templateIds: [templateId] });
    await run(kit.env.DB, 'UPDATE scan_events SET reentry=1 WHERE id=?', [event.id]);
    const scanner = await kit.scanner({
      eventId: event.id,
      settings: { checkIn: { mode: 'in_out' }, direction: 'both' },
    });
    const pass = await kit.scanPass(templateId);
    const entry = await transition(scanner.headers, pass);
    expect(entry.kind).toBe('ok');
    if (!entry.scanId) throw new Error('Missing entry scan');
    const exit = await transition(scanner.headers, pass);
    if (!exit.scanId) throw new Error('Missing exit scan');
    const undo = await kit.post(scanner.headers, `/scans/${exit.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(undo.status).toBe(200);
    const restored = (await undo.json()) as ScanOutcome;
    expect(restored.kind).toBe('ok');
    if (!restored.scanId) throw new Error('Missing undo scan');
    await hardDelete(pass);
    // The undo row carries no proof (it cannot be captured); it does not block the entry it restored.
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_retained_gates WHERE scan_id=?', [
        restored.scanId,
      ]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        'SELECT state,presence_state FROM scan_retained_gates WHERE scan_id=?',
        [entry.scanId],
      ),
    ).toEqual({ state: 'in', presence_state: 'in' });
    expect(await scopedCount(kit.org.id, event.id)).toBe(1);
    expect(await scopedCount(kit.org.id, event.id, true)).toBe(1);
  });
}
