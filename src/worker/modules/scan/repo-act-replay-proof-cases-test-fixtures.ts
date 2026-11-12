import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import {
  act,
  CHECK_IN,
  expectOriginalLedger,
  expectReceipt,
  expectUnavailable,
  kit,
  out,
  rows,
  tpl,
} from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerReplayProof() {
  it('the same key twice gives the same scanId, replay true and one ledger row', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = await out(await act(s.headers, codeOf(pass), { idempotencyKey }));
    const second = await out(await act(s.headers, codeOf(pass), { idempotencyKey }));
    expectReceipt(second, original);
    expect(second.action).toEqual(CHECK_IN);
    expect(second.display).toBeNull();
    const ledger = await rows('SELECT id FROM pass_events WHERE pass_id = ? AND kind = ?', [
      pass.id,
      'scan.checked_in',
    ]);
    expect(ledger).toHaveLength(1);
    const entry = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_in'",
      [pass.id],
    );
    if (!entry) throw new Error('Missing scan event');
    expect(JSON.parse(entry.data).authority.gate).toMatchObject({
      exists: true,
      orgId: kit.org.id,
      mode: 'live',
      templateId: tpl,
      kind: 'check_in',
      scope: '',
      scanId: original.scanId,
      state: 'in',
      count: 1,
      firstAt: expect.any(Number),
      lastAt: expect.any(Number),
      prevState: null,
      prevLastAt: null,
      prevScanId: null,
      scanState: 'done',
      undoneBy: null,
    });
  });

  it.each([
    ['organization', "org_id = 'other-org'"],
    ['mode', "mode = 'test'"],
    ['template', "template_id = 'other-template'"],
    ['kind', "kind = 'other-kind'"],
    ['scope', "scope = 'event:changed'"],
    ['state', "state = 'out'"],
    ['count', 'count = count + 1'],
    ['first time', 'first_at = first_at + 1'],
    ['last time', 'last_at = last_at + 1'],
    ['previous state', "prev_state = 'out'"],
    ['previous time', 'prev_last_at = 1'],
    ['previous scan', "prev_scan_id = 'other-scan'"],
  ])(
    'keeps a success receipt when the current gate %s changes under the same scan id',
    async (_field, mutation) => {
      const scanner = await kit.scanner({ templateIds: [tpl] });
      const pass = await kit.scanPass(tpl);
      const idempotencyKey = key();
      const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
      expect(original.kind).toBe('ok');
      await run(kit.env.DB, `UPDATE scan_gates SET ${mutation} WHERE pass_id = ?`, [pass.id]);
      const gate = await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]);
      expect(gate).toMatchObject({ last_scan_id: original.scanId });
      const replay = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
      expectReceipt(replay, original);
      expect(
        await first(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id = ?', [pass.id]),
      ).toEqual(gate);
      await expectOriginalLedger(pass.id, original.scanId);
    },
  );

  it('masks success replay when a required nullable gate snapshot field is missing', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    await run(
      kit.env.DB,
      `UPDATE pass_events SET data = json_remove(data, '$.authority.gate.prevState')
      WHERE pass_id = ? AND kind = 'scan.checked_in'`,
      [pass.id],
    );
    expectUnavailable(await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })));
    await expectOriginalLedger(pass.id, original.scanId);
  });

  it.each([
    ['changed nonquarantine proof', "json_set(data, '$.authority.nonQuarantined', json('false'))"],
    ['missing credential generation', "json_remove(data, '$.authority.credentialGeneration')"],
    ['missing lifecycle generation', "json_remove(data, '$.authority.lifecycleGeneration')"],
    ['changed lifecycle generation', "json_set(data, '$.authority.lifecycleGeneration', -1)"],
    ['missing transfer proof', "json_remove(data, '$.authority.noPendingTransfer')"],
    ['pending transfer proof', "json_set(data, '$.authority.noPendingTransfer', json('false'))"],
  ])('refuses a completed scan with %s', async (_change, mutation) => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    const event = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_in'",
      [pass.id],
    );
    if (!event) throw new Error('Missing scan event');
    expect(JSON.parse(event.data).authority).not.toHaveProperty('eventProof');
    await run(
      kit.env.DB,
      `UPDATE pass_events SET data = ${mutation}
      WHERE pass_id = ? AND kind = 'scan.checked_in'`,
      [pass.id],
    );
    expectUnavailable(await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })));
    await expectOriginalLedger(pass.id, original.scanId);
  });

  it.each(['missing', 'mismatched'] as const)(
    'masks a replay with %s pinned release provenance',
    async (change) => {
      const scanner = await kit.scanner({ templateIds: [tpl] });
      const pass = await kit.scanPass(tpl);
      const idempotencyKey = key();
      const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
      expect(original.kind).toBe('ok');
      await run(
        kit.env.DB,
        change === 'missing'
          ? "UPDATE pass_events SET data = json_remove(data, '$.authority.pinnedReleaseId') WHERE pass_id = ? AND kind = 'scan.checked_in'"
          : "UPDATE pass_events SET data = json_set(data, '$.authority.pinnedReleaseId', 'unrelated-release') WHERE pass_id = ? AND kind = 'scan.checked_in'",
        [pass.id],
      );
      expectUnavailable(await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })));
      await expectOriginalLedger(pass.id, original.scanId);
    },
  );
}
