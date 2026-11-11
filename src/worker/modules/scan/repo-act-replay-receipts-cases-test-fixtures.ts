import { expect, it, vi } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import {
  act,
  CHECK_IN,
  expectOriginalLedger,
  expectReceipt,
  expectRedactedReceipt,
  expectUnavailable,
  kit,
  MINUTE,
  out,
  rows,
  tpl,
} from './act-test-fixtures.ts';
import { publishScan } from './live.ts';
import { codeOf, key, setupScanKit } from './test-kit.ts';

export function registerReplayReceipts() {
  it('rejects a different request and makes no live, ledger, gate or count-cache changes', async () => {
    const event = await kit.event({ templateIds: [tpl] });
    const s = await kit.scanner({ eventId: event.id });
    const [a, b] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    const idempotencyKey = key();
    const original = await out(await act(s.headers, codeOf(a), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    const staleCacheAt = kit.clock.now() - 2 * MINUTE;
    await run(kit.env.DB, 'UPDATE scan_events SET expected = ?, expected_at = ? WHERE id = ?', [
      987654,
      staleCacheAt,
      event.id,
    ]);
    const effects = async () => ({
      scans: await rows('SELECT * FROM scans WHERE scanner_id = ? ORDER BY id', [s.id]),
      ledger: await rows<{ kind: string }>(
        'SELECT * FROM pass_events WHERE pass_id IN (?, ?) ORDER BY id',
        [a.id, b.id],
      ),
      proofs: await rows(
        `SELECT * FROM scan_retention_proofs
        WHERE scan_id IN (SELECT id FROM scans WHERE scanner_id = ?) ORDER BY scan_id`,
        [s.id],
      ),
      gates: await rows(
        'SELECT * FROM scan_gates WHERE pass_id IN (?, ?) ORDER BY pass_id, action_id, scope',
        [a.id, b.id],
      ),
      presence: await rows(
        'SELECT * FROM scan_presence WHERE pass_id IN (?, ?) ORDER BY pass_id, scope',
        [a.id, b.id],
      ),
      cache: await first(kit.env.DB, 'SELECT expected, expected_at FROM scan_events WHERE id = ?', [
        event.id,
      ]),
    });
    const committed = await effects();
    expect(committed.scans).toHaveLength(1);
    expect(committed.proofs).toHaveLength(1);
    expect(committed.gates).toHaveLength(1);
    expect(committed.ledger.filter((row) => row.kind === 'scan.checked_in')).toHaveLength(1);
    expect(committed.cache).toEqual({ expected: 987654, expected_at: staleCacheAt });
    vi.mocked(publishScan).mockClear();

    const replay = await out(await act(s.headers, codeOf(a), { idempotencyKey }));
    expectReceipt(replay, original);
    expect(await effects()).toEqual(committed);
    expect(vi.mocked(publishScan)).not.toHaveBeenCalled();

    const res = await act(s.headers, codeOf(b), { idempotencyKey });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await effects()).toEqual(committed);
    expect(vi.mocked(publishScan)).not.toHaveBeenCalled();
  });

  it('returns only a minimal receipt after a real completed credential transfer', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(
      tpl,
      { memberName: 'Prior Holder Credential' },
      {
        holderEmail: 'receipt-old@example.test',
      },
    );
    const input = { passId: pass.id, method: 'manual' as const };
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, input, { idempotencyKey }));
    expect(original.kind).toBe('ok');
    const gate = await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id]);
    const scan = await first(kit.env.DB, 'SELECT * FROM scans WHERE id=?', [original.scanId ?? '']);
    const ledger = await rows("SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
      pass.id,
    ]);
    expect(ledger).toHaveLength(1);
    const expected = await getHolderPass(kit.env.DB, pass.id, null);
    if (!expected) throw new Error('Missing completed-transfer source');
    const transfer = await startCredentialTransfer(
      jobCtxOf(kit),
      { type: 'system', id: null },
      pass.id,
      {
        holderEmail: 'receipt-new@example.test',
        ownerUserId: null,
      },
      null,
      { kind: 'tenant-holder', expected },
    );
    expect(transfer.state).toBe('completed');
    const current = await first<{ serial: string; credential_generation: number }>(
      kit.env.DB,
      'SELECT serial,credential_generation FROM passes WHERE id=?',
      [pass.id],
    );
    expect(current?.credential_generation).toBe(expected.credentialGeneration + 1);
    expect(current?.serial).not.toBe(pass.serial);
    const replay = await out(await act(scanner.headers, input, { idempotencyKey }));
    expectRedactedReceipt(replay, original);
    expect(JSON.stringify(replay)).not.toContain('Prior Holder Credential');
    expect(await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id])).toEqual(
      gate,
    );
    expect(
      await first(kit.env.DB, 'SELECT * FROM scans WHERE id=?', [original.scanId ?? '']),
    ).toEqual(scan);
    expect(
      await rows("SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [pass.id]),
    ).toEqual(ledger);
    await expectOriginalLedger(pass.id, original.scanId);
  }, 60_000);

  it('masks a completed receipt while a real provider-backed transfer is pending', async () => {
    const scoped = await setupScanKit();
    const templateId = await scoped.scanTemplate('Pending receipt transfer', {
      actions: [CHECK_IN],
    });
    const template = await scoped.registry.resolve(templateId);
    const apple = await approveAppleRelease(scoped, { templateId, version: template.version });
    const pass = await scoped.scanPass(
      templateId,
      { memberName: 'Pending Holder Credential' },
      {
        holderEmail: 'pending-old@example.test',
      },
    );
    await setupSamsungCallbacks({
      promoted: false,
      source: { kit: { ...scoped, template }, apple, pass, barcode: 'qr' },
    });
    const scanner = await scoped.scanner({ templateIds: [templateId] });
    const request = {
      idempotencyKey: key(),
      input: { passId: pass.id, method: 'manual' as const },
      clientTs: scoped.clock.now(),
      actionId: 'auto',
    };
    const response = await scoped.post(scanner.headers, '/actions', request);
    expect(response.status).toBe(200);
    const original = await out(response);
    expect(original.kind).toBe('ok');
    const db = scoped.env.DB;
    const gate = await first(db, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id]);
    const scan = await first(db, 'SELECT * FROM scans WHERE id=?', [original.scanId ?? '']);
    const events = await all(
      db,
      "SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
      [pass.id],
    );
    expect(events).toHaveLength(1);
    const expected = await getHolderPass(db, pass.id, null);
    if (!expected) throw new Error('Missing pending-transfer source');
    const transfer = await startCredentialTransfer(
      jobCtxOf(scoped),
      { type: 'system', id: null },
      pass.id,
      {
        holderEmail: 'pending-new@example.test',
        ownerUserId: null,
      },
      null,
      { kind: 'tenant-holder', expected },
    );
    expect(transfer.state).toBe('pending');
    expect(
      await first(
        db,
        `SELECT state,source_generation,target_generation
      FROM pass_credential_transfers WHERE id=?`,
        [transfer.transferId],
      ),
    ).toEqual({
      state: 'pending',
      source_generation: expected.credentialGeneration,
      target_generation: expected.credentialGeneration + 1,
    });
    expect(
      await first(
        db,
        'SELECT serial,credential_generation,link_generation FROM passes WHERE id=?',
        [pass.id],
      ),
    ).toEqual({
      serial: pass.serial,
      credential_generation: expected.credentialGeneration + 1,
      link_generation: expected.linkGeneration + 1,
    });
    const replay = await scoped.post(scanner.headers, '/actions', request);
    expect(replay.status).toBe(200);
    const outcome = await out(replay);
    expectUnavailable(outcome);
    expect(JSON.stringify(outcome)).not.toContain('Pending Holder Credential');
    expect(await first(db, 'SELECT * FROM scan_gates WHERE pass_id=?', [pass.id])).toEqual(gate);
    expect(await first(db, 'SELECT * FROM scans WHERE id=?', [original.scanId ?? ''])).toEqual(
      scan,
    );
    expect(
      await all(db, "SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [pass.id]),
    ).toEqual(events);
  }, 180_000);

  it('returns a heads-up receipt without the previous scan or override affordance', async () => {
    const a = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const admitted = await out(await act(a.headers, codeOf(pass)));
    const idempotencyKey = key();
    const original = await out(await act(a.headers, codeOf(pass), { idempotencyKey }));
    expect(original).toMatchObject({
      kind: 'heads_up',
      reason: 'already_done',
      previous: { scanId: admitted.scanId },
    });
    const again = await out(await act(a.headers, codeOf(pass), { idempotencyKey }));
    expectReceipt(again, original);
  });
}
