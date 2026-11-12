import { expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { getEvent } from './repo-scope.ts';
import {
  attachSession,
  CHECK_IN,
  kit,
  receiptCurrent,
  scannerSnapshot,
  strict,
} from './repo-session-authority-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerSessionHistoryCases() {
  it.each(['event', 'templates', 'workspace'] as const)(
    'retains the original %s assignment after its template is archived',
    async (kind) => {
      const template = await kit.scanTemplate('Historical receipt', { actions: [CHECK_IN] });
      const pass = await kit.scanPass(template);
      const event = kind === 'event' ? await kit.event({ templateIds: [template] }) : null;
      const scanner = await kit.scanner(
        event ? { eventId: event.id } : { templateIds: [template] },
      );
      const sessionId =
        kind === 'workspace'
          ? await attachSession(scanner.id, {
              accepts: JSON.stringify({ templateIds: [template] }),
            })
          : null;
      const response = await kit.post(scanner.headers, '/actions', {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
        actionId: 'auto',
      });
      expect(response.status).toBe(200);
      const receipt = (await response.json()) as { kind: string; scanId: string | null };
      expect(receipt).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
      if (!receipt.scanId) throw new Error('Missing recorded scan.');
      // An archived template keeps its release in scope: existing passes still scan.
      await run(kit.env.DB, `UPDATE templates SET status='archived' WHERE id=?`, [template]);
      const actor = await scannerSnapshot(scanner.id);
      expect(actor.invalidScannerScope).toBeFalsy();
      expect(actor.scannerAssignment).toMatchObject({
        scannerId: scanner.id,
        templateIds: [template],
        structurallyValid: true,
      });
      expect(await strict(actor)).toBe(true);
      const observedEvent = event ? await getEvent(kit.env.DB, kit.org.id, event.id) : null;
      if (event && !observedEvent) throw new Error('Missing event snapshot.');
      const events = observedEvent ? [observedEvent] : [];
      expect(await receiptCurrent(actor, receipt.scanId, events)).toBe(true);
      const history = await kit.get(scanner.headers, '/scans');
      expect(history.status).toBe(200);
      expect(await history.json()).toMatchObject({
        items: [{ scanId: receipt.scanId, outcome: 'ok', reason: null }],
      });
      const summary = await kit.get(scanner.headers, '/summary');
      expect(summary.status).toBe(200);
      expect(await summary.json()).toMatchObject({ total: 1, ok: 1 });
      if (event) {
        await run(
          kit.env.DB,
          'DELETE FROM scan_event_templates WHERE event_id=? AND template_id=?',
          [event.id, template],
        );
      } else if (sessionId) {
        await run(
          kit.env.DB,
          `UPDATE scanning_sessions SET accepts=NULL,updated_at=updated_at+1 WHERE id=?`,
          [sessionId],
        );
      } else {
        await run(
          kit.env.DB,
          'DELETE FROM scanner_templates WHERE scanner_id=? AND template_id=?',
          [scanner.id, template],
        );
      }
      expect(await receiptCurrent(actor, receipt.scanId, events)).toBe(false);
    },
  );

  it('does not revive a workspace template missing at the original guard snapshot', async () => {
    const template = await kit.scanTemplate('Deleted workspace template', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(template);
    const scanner = await kit.scanner();
    await attachSession(scanner.id, { accepts: JSON.stringify({ templateIds: [template] }) });
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'auto',
    });
    const receipt = (await response.json()) as { scanId: string | null };
    if (!receipt.scanId) throw new Error('Missing recorded scan.');
    await run(kit.env.DB, `UPDATE templates SET status='deleted' WHERE id=?`, [template]);
    const actor = await scannerSnapshot(scanner.id);
    expect(actor.invalidScannerScope).toBe(true);
    await run(kit.env.DB, `UPDATE templates SET status='active' WHERE id=?`, [template]);
    expect(await receiptCurrent(actor, receipt.scanId, [])).toBe(false);
  });

  it('fences standalone template ownership and status captured by the guard', async () => {
    const template = await kit.scanTemplate('Standalone template', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(template);
    const scanner = await kit.scanner({ templateIds: [template] });
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'auto',
    });
    const receipt = (await response.json()) as { scanId: string | null };
    if (!receipt.scanId) throw new Error('Missing recorded scan.');
    await run(kit.env.DB, `UPDATE templates SET status='archived' WHERE id=?`, [template]);
    const actor = await scannerSnapshot(scanner.id);
    expect(await receiptCurrent(actor, receipt.scanId, [])).toBe(true);
    await run(kit.env.DB, `UPDATE templates SET status='active' WHERE id=?`, [template]);
    expect(await receiptCurrent(actor, receipt.scanId, [])).toBe(false);
  });

  it('never returns a receipt after the captured scanner credential is rotated', async () => {
    const template = await kit.scanTemplate('Credential receipt', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(template);
    const scanner = await kit.scanner({ templateIds: [template] });
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'auto',
    });
    const receipt = (await response.json()) as { scanId: string | null };
    if (!receipt.scanId) throw new Error('Missing recorded scan.');
    await run(kit.env.DB, `UPDATE templates SET status='archived' WHERE id=?`, [template]);
    const actor = await scannerSnapshot(scanner.id);
    expect(await receiptCurrent(actor, receipt.scanId, [])).toBe(true);
    await run(kit.env.DB, 'UPDATE scanners SET token_hash=?,updated_at=updated_at+1 WHERE id=?', [
      'rotated',
      scanner.id,
    ]);
    expect(await receiptCurrent(actor, receipt.scanId, [])).toBe(false);
  });

  it.each(['amount', 'before_value', 'after_value'] as const)(
    'omits a summary action bucket containing unsigned %s data',
    async (field) => {
      const template = await kit.scanTemplate('Signed check-in', { actions: [CHECK_IN] });
      const pass = await kit.scanPass(template);
      const scanner = await kit.scanner({ templateIds: [template] });
      const response = await kit.post(scanner.headers, '/actions', {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
        actionId: 'auto',
      });
      const receipt = (await response.json()) as { scanId: string | null };
      if (!receipt.scanId) throw new Error('Missing recorded scan.');
      const before = await kit.get(scanner.headers, '/summary');
      expect(await before.json()).toMatchObject({
        total: 1,
        ok: 1,
        byAction: [{ actionId: 'check_in', count: 1, amount: 0 }],
      });
      await run(kit.env.DB, `UPDATE scans SET ${field}=? WHERE id=?`, [
        field === 'amount' ? 7 : '7',
        receipt.scanId,
      ]);
      const after = await kit.get(scanner.headers, '/summary');
      expect(await after.json()).toMatchObject({ total: 1, ok: 1, byAction: [] });
    },
  );

  it('keeps unsigned history minimal but never treats it as a signed receipt', async () => {
    const template = await kit.scanTemplate('Unsigned history', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(template);
    const scanner = await kit.scanner({ templateIds: [template] });
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'auto',
    });
    const receipt = (await response.json()) as { scanId: string | null };
    if (!receipt.scanId) throw new Error('Missing recorded scan.');
    await run(
      kit.env.DB,
      `DELETE FROM pass_events WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
      [pass.id, receipt.scanId],
    );
    const actor = await scannerSnapshot(scanner.id);
    expect(await receiptCurrent(actor, receipt.scanId, [])).toBe(false);
    const history = await kit.get(scanner.headers, '/scans');
    expect(await history.json()).toMatchObject({
      items: [
        {
          scanId: receipt.scanId,
          outcome: 'ok',
          reason: null,
          actionLabel: 'Scan',
          title: null,
          value: null,
          undoable: false,
        },
      ],
    });
    const summary = await kit.get(scanner.headers, '/summary');
    expect(await summary.json()).toMatchObject({ total: 1, ok: 1, byAction: [] });
  });

  it('does not use a fabricated or mismatched scanner assignment as history authority', async () => {
    const template = await kit.scanTemplate('Original scope', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(template);
    const event = await kit.event({ templateIds: [template] });
    const scanner = await kit.scanner({ eventId: event.id });
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'auto',
    });
    const receipt = (await response.json()) as { scanId: string | null };
    if (!receipt.scanId) throw new Error('Missing recorded scan.');
    const observedEvent = await getEvent(kit.env.DB, kit.org.id, event.id);
    if (!observedEvent) throw new Error('Missing event snapshot.');
    const actor = await scannerSnapshot(scanner.id);
    expect(await receiptCurrent(actor, receipt.scanId, [observedEvent])).toBe(true);
    expect(
      await receiptCurrent({ ...actor, scannerAssignment: null }, receipt.scanId, [observedEvent]),
    ).toBe(false);
    expect(await receiptCurrent(actor, receipt.scanId, [])).toBe(false);
    const otherTemplate = await kit.scanTemplate('Other scope', { actions: [CHECK_IN] });
    const otherEvent = await kit.event({ templateIds: [otherTemplate] });
    await run(kit.env.DB, 'UPDATE scanners SET event_id=?,updated_at=updated_at+1 WHERE id=?', [
      otherEvent.id,
      scanner.id,
    ]);
    const reassigned = await scannerSnapshot(scanner.id);
    expect(await receiptCurrent(reassigned, receipt.scanId, [observedEvent])).toBe(false);
  });

  it('requires the recorded ledger event and template to match the scan assignment', async () => {
    const template = await kit.scanTemplate('Ledger event scope', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(template);
    const event = await kit.event({ templateIds: [template] });
    const scanner = await kit.scanner({ eventId: event.id });
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'auto',
    });
    const receipt = (await response.json()) as { scanId: string | null };
    if (!receipt.scanId) throw new Error('Missing recorded scan.');
    const observedEvent = await getEvent(kit.env.DB, kit.org.id, event.id);
    if (!observedEvent) throw new Error('Missing event snapshot.');
    const actor = await scannerSnapshot(scanner.id);
    expect(await receiptCurrent(actor, receipt.scanId, [observedEvent])).toBe(true);
    await run(
      kit.env.DB,
      `UPDATE pass_events SET data=json_set(data,'$.authority.eventId',?)
      WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
      ['different-event', pass.id, receipt.scanId],
    );
    expect(await receiptCurrent(actor, receipt.scanId, [observedEvent])).toBe(false);
  });
}
