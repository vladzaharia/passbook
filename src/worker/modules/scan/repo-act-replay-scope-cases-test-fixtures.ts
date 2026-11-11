import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import {
  act,
  CHECK_IN,
  expectOriginalLedger,
  expectReceipt,
  expectRedactedReceipt,
  expectUnavailable,
  kit,
  out,
  reviseReplayTemplate,
  rows,
  tpl,
} from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerReplayScope() {
  it('redacts when the scanner no longer accepts the recorded template', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    await run(
      kit.env.DB,
      'DELETE FROM scanner_templates WHERE scanner_id = ? AND template_id = ?',
      [scanner.id, tpl],
    );
    const response = await act(scanner.headers, codeOf(pass), { idempotencyKey });
    expect(response.status).toBe(200);
    const replay = await out(response);
    expectUnavailable(replay, 'not_accepted');
    await expectOriginalLedger(pass.id, original.scanId);
    expect(JSON.stringify(replay)).not.toContain('Anna Popescu');
  });

  it('redacts after the source event stops accepting the pass', async () => {
    const event = await kit.event({ templateIds: [tpl] });
    await run(kit.env.DB, 'UPDATE scan_events SET match_input = ?, match_values = ? WHERE id = ?', [
      'tier',
      '["gold"]',
      event.id,
    ]);
    const scanner = await kit.scanner({ eventId: event.id });
    const pass = await kit.scanPass(tpl, { tier: 'gold' });
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    await run(
      kit.env.DB,
      'UPDATE scan_events SET match_values = ?, updated_at = updated_at + 1 WHERE id = ?',
      ['["silver"]', event.id],
    );
    const response = await act(scanner.headers, codeOf(pass), { idempotencyKey });
    expect(response.status).toBe(200);
    const replay = await out(response);
    expectRedactedReceipt(replay, original);
    await expectOriginalLedger(pass.id, original.scanId);
    expect(JSON.stringify(replay)).not.toContain('Anna Popescu');
  });

  it('redacts a pass whose upstream connection has been disabled', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const connection = kit.fx.ids.id();
    await run(
      kit.env.DB,
      "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'fixture', 'Replay source', ?, ?)",
      [connection, kit.org.id, kit.clock.now(), kit.clock.now()],
    );
    await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
      connection,
      'member',
      pass.id,
    ]);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [connection]);
    const response = await act(scanner.headers, codeOf(pass), { idempotencyKey });
    expect(response.status).toBe(200);
    const replay = await out(response);
    expectRedactedReceipt(replay, original);
    await expectOriginalLedger(pass.id, original.scanId);
    expect(JSON.stringify(replay)).not.toContain('Anna Popescu');
  });

  it('uses the new staff member’s role without revealing the prior manager’s data', async () => {
    const secret = 'MANAGER-ONLY-BEFORE-STAFF-TAKEOVER';
    const template = await kit.scanTemplate('Staff takeover replay', {
      actions: [CHECK_IN],
      display: {
        v: 1,
        holder: '{{inputs.memberName}}',
        header: {},
        panels: [
          {
            id: 'details',
            rows: [{ id: 'tier', type: 'field', label: 'Manager tier', value: '{{inputs.tier}}' }],
          },
        ],
      },
    });
    await reviseReplayTemplate(template, (manifest) => {
      if (!manifest.inputs.properties) throw new Error('Missing input properties');
      manifest.inputs.properties.tier = { type: 'string', 'x-scan': 'manager' };
    });
    const source = await kit.staff('manager', 'Replay source');
    const recipient = await kit.staff('door', 'Replay recipient');
    const scanner = await kit.scanner({
      templateIds: [template],
      settings: { staffSignIn: true },
      staffId: source.id,
    });
    const pass = await kit.scanPass(template, { tier: secret });
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    expect(JSON.stringify(original)).toContain(secret);
    await run(
      kit.env.DB,
      'UPDATE scanners SET staff_id = ?, staff_since = ?, staff_seen_at = ?, updated_at = updated_at + 1 WHERE id = ?',
      [recipient.id, kit.clock.now(), kit.clock.now(), scanner.id],
    );
    const response = await act(scanner.headers, codeOf(pass), { idempotencyKey });
    expect(response.status).toBe(200);
    const replay = await out(response);
    expectReceipt(replay, original);
    await expectOriginalLedger(pass.id, original.scanId);
    expect(JSON.stringify(replay)).not.toContain(secret);
    expect(JSON.stringify(replay)).not.toContain('Replay source');
  });

  it('returns a no-match receipt from the scan row and denies it once the row stops being passless', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const idempotencyKey = key();
    const input = { code: 'REPLAY-NO-MATCH-674', method: 'camera' };
    const original = await out(await act(scanner.headers, input, { idempotencyKey }));
    expect(original).toMatchObject({ kind: 'refused', reason: 'not_found' });
    const replay = await out(await act(scanner.headers, input, { idempotencyKey }));
    expectRedactedReceipt(replay, original);
    await run(kit.env.DB, "UPDATE scans SET reason='needs_approval' WHERE id=?", [
      original.scanId ?? '',
    ]);
    expectUnavailable(await out(await act(scanner.headers, input, { idempotencyKey })));
    expect(
      await rows('SELECT id FROM scans WHERE idempotency_key = ?', [idempotencyKey]),
    ).toHaveLength(1);
  });

  it('replays an ambiguous no-selection refusal without associating either pass', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const a = await kit.scanPass(tpl, { memberName: 'Ambiguous Private A' });
    const b = await kit.scanPass(tpl, { memberName: 'Ambiguous Private B' });
    const lookup = await sha256Hex('AMBIGLOOKUP');
    for (const pass of [a, b])
      await run(kit.env.DB, 'UPDATE passes SET lookup_hash=? WHERE id=?', [lookup, pass.id]);
    const idempotencyKey = key();
    const input = { code: 'ambig-lookup', method: 'wedge' };
    const original = await out(await act(scanner.headers, input, { idempotencyKey }));
    expect(original).toMatchObject({
      kind: 'refused',
      reason: 'ambiguous',
      action: null,
      display: null,
    });
    const row = await first(kit.env.DB, 'SELECT * FROM scans WHERE id=?', [original.scanId ?? '']);
    expect(row).toMatchObject({
      pass_id: null,
      template_id: null,
      action_id: null,
      action_kind: null,
    });
    if (a.scanCode === null || b.scanCode === null) throw new Error('Missing pass scan code');
    for (const secret of [
      a.id,
      b.id,
      a.serial,
      b.serial,
      a.scanCode,
      b.scanCode,
      'Ambiguous Private A',
      'Ambiguous Private B',
      input.code,
      tpl,
    ]) {
      expect(JSON.stringify(row)).not.toContain(secret);
    }
    const replay = await out(await act(scanner.headers, input, { idempotencyKey }));
    expectRedactedReceipt(replay, original);
    expect(
      await first(kit.env.DB, 'SELECT * FROM scans WHERE id=?', [original.scanId ?? '']),
    ).toEqual(row);
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id IN (?,?) AND kind LIKE 'scan.%'", [
        a.id,
        b.id,
      ]),
    ).toHaveLength(0);
  });
}
