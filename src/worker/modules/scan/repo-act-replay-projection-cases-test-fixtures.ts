import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import {
  act,
  CHECK_IN,
  expectOriginalLedger,
  expectReceipt,
  kit,
  out,
  reviseReplayTemplate,
} from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerReplayProjection() {
  it('hides fields, flags and action labels after the scanner role is lowered', async () => {
    const secret = 'DESK-ONLY-TIER-449';
    const template = await kit.scanTemplate('Role replay', {
      actions: [{ ...CHECK_IN, label: secret }],
      flags: [{ input: 'tier', label: 'Desk tier flag' }],
      display: {
        v: 1,
        holder: '{{inputs.memberName}}',
        header: {},
        panels: [
          {
            id: 'p_details',
            rows: [{ id: 'r_tier', type: 'field', label: 'Tier', value: '{{inputs.tier}}' }],
          },
        ],
      },
    });
    await reviseReplayTemplate(template, (manifest) => {
      if (!manifest.inputs.properties) throw new Error('Missing input properties');
      manifest.inputs.properties.tier = { type: 'string', 'x-scan': 'desk' };
      manifest.inputs.properties.balance = { type: 'integer', 'x-scan': 'hidden' };
    });
    const scanner = await kit.scanner({
      templateIds: [template],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const pass = await kit.scanPass(template, { tier: secret, balance: 1 });
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    await run(
      kit.env.DB,
      "UPDATE scanners SET settings = json_set(settings, '$.roleWithoutSignIn', 'door'), updated_at = updated_at + 1 WHERE id = ?",
      [scanner.id],
    );
    const response = await act(scanner.headers, codeOf(pass), { idempotencyKey });
    expect(response.status).toBe(200);
    const replay = await out(response);
    expectReceipt(replay, original);
    expect(replay.action).toBeNull();
    await expectOriginalLedger(pass.id, original.scanId);
    expect(JSON.stringify(replay)).not.toContain(secret);
    expect(JSON.stringify(replay)).not.toContain('Desk tier flag');
    if (pass.scanCode === null) throw new Error('Missing pass scan code');
    expect(JSON.stringify(replay)).not.toContain(pass.scanCode);
  });

  it('reprojects a replay after a manager is downgraded to door without rewriting its ledger', async () => {
    const secret = 'MANAGER-ONLY-REPLAY-DETAIL';
    const template = await kit.scanTemplate('Staff role replay', {
      actions: [CHECK_IN],
      flags: [{ input: 'tier', label: 'Sensitive tier' }],
      display: {
        v: 1,
        holder: '{{inputs.memberName}}',
        header: {},
        panels: [
          {
            id: 'p_details',
            rows: [{ id: 'r_tier', type: 'field', label: 'Tier', value: '{{inputs.tier}}' }],
          },
        ],
      },
    });
    await reviseReplayTemplate(template, (manifest) => {
      if (!manifest.inputs.properties) throw new Error('Missing input properties');
      manifest.inputs.properties.tier = { type: 'string', 'x-scan': 'manager' };
    });
    const manager = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [template],
      staffId: manager.id,
      settings: { staffSignIn: true },
    });
    const pass = await kit.scanPass(template, { tier: secret });
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    await run(
      kit.env.DB,
      "UPDATE scan_staff SET role = 'door', updated_at = updated_at + 1 WHERE id = ?",
      [manager.id],
    );
    const replay = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(replay).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: original.scanId,
      action: CHECK_IN,
    });
    expectReceipt(replay, original);
    expect(JSON.stringify(replay)).not.toContain(secret);
    expect(JSON.stringify(replay)).not.toContain('Sensitive tier');
    await expectOriginalLedger(pass.id, original.scanId);
  });

  it('reprojects a visible action after the scanner role is downgraded', async () => {
    const secret = 'SCANNER-DESK-DETAIL';
    const template = await kit.scanTemplate('Scanner role replay', {
      actions: [CHECK_IN],
      flags: [{ input: 'tier', label: 'Desk tier' }],
    });
    await reviseReplayTemplate(template, (manifest) => {
      if (!manifest.inputs.properties) throw new Error('Missing input properties');
      manifest.inputs.properties.tier = { type: 'string', 'x-scan': 'desk' };
    });
    const scanner = await kit.scanner({
      templateIds: [template],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const pass = await kit.scanPass(template, { tier: secret });
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    await run(
      kit.env.DB,
      "UPDATE scanners SET settings = json_set(settings, '$.roleWithoutSignIn', 'door'), updated_at = updated_at + 1 WHERE id = ?",
      [scanner.id],
    );
    const replay = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(replay).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: original.scanId,
      action: CHECK_IN,
    });
    expectReceipt(replay, original);
    expect(JSON.stringify(replay)).not.toContain(secret);
    expect(JSON.stringify(replay)).not.toContain('Desk tier');
    await expectOriginalLedger(pass.id, original.scanId);
  });

  it('returns the receipt but hides an action a downgraded staff member cannot perform', async () => {
    const template = await kit.scanTemplate('Manager-only replay', {
      actions: [{ ...CHECK_IN, minRole: 'manager' }],
    });
    const manager = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [template],
      staffId: manager.id,
      settings: { staffSignIn: true },
    });
    const pass = await kit.scanPass(template);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    await run(
      kit.env.DB,
      "UPDATE scan_staff SET role = 'door', updated_at = updated_at + 1 WHERE id = ?",
      [manager.id],
    );
    const replay = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expectReceipt(replay, original);
    expect(replay.action).toBeNull();
    await expectOriginalLedger(pass.id, original.scanId);
  });

  it('does not reveal an action whose source input becomes hidden', async () => {
    const template = await kit.scanTemplate('Hidden action source', {
      actions: [{ ...CHECK_IN, input: 'tier' }],
    });
    await reviseReplayTemplate(template, (manifest) => {
      if (!manifest.inputs.properties) throw new Error('Missing input properties');
      manifest.inputs.properties.tier = { type: 'string', 'x-scan': 'desk' };
    });
    const scanner = await kit.scanner({
      templateIds: [template],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const pass = await kit.scanPass(template, { tier: 'PRIVATE-RECORD-SOURCE' });
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    await run(
      kit.env.DB,
      "UPDATE scanners SET settings = json_set(settings, '$.roleWithoutSignIn', 'door'), updated_at = updated_at + 1 WHERE id = ?",
      [scanner.id],
    );
    const response = await act(scanner.headers, codeOf(pass), { idempotencyKey });
    expect(response.status).toBe(200);
    const replay = await out(response);
    expectReceipt(replay, original);
    expect(replay.action).toBeNull();
    await expectOriginalLedger(pass.id, original.scanId);
    expect(JSON.stringify(replay)).not.toContain('PRIVATE-RECORD-SOURCE');
  });

  it('does not leak a hidden value through the previous scanner name', async () => {
    const secret = 'PRIVATE-SCANNER-NAME';
    const template = await kit.scanTemplate('Hidden previous', { actions: [CHECK_IN] });
    await reviseReplayTemplate(template, (manifest) => {
      if (!manifest.inputs.properties) throw new Error('Missing input properties');
      manifest.inputs.properties.tier = { type: 'string', 'x-scan': 'hidden' };
    });
    const scanner = await kit.scanner({ templateIds: [template] });
    await run(
      kit.env.DB,
      'UPDATE scanners SET name = ?, updated_at = updated_at + 1 WHERE id = ?',
      [secret, scanner.id],
    );
    const pass = await kit.scanPass(template, { tier: secret });
    await act(scanner.headers, codeOf(pass));
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original).toMatchObject({ kind: 'heads_up', reason: 'already_done' });
    const replay = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expectReceipt(replay, original);
    expect(JSON.stringify(replay)).not.toContain(secret);
  });

  it('uses the current template policy for a replay of an older pass', async () => {
    const secret = 'FORMERLY-VISIBLE-TIER';
    const template = await kit.scanTemplate('Policy replay', {
      actions: [CHECK_IN],
      display: {
        v: 1,
        holder: '{{inputs.memberName}}',
        header: {},
        panels: [
          {
            id: 'p_details',
            rows: [{ id: 'r_tier', type: 'field', label: 'Tier', value: '{{inputs.tier}}' }],
          },
        ],
      },
    });
    await reviseReplayTemplate(template, () => {});
    const scanner = await kit.scanner({
      templateIds: [template],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const pass = await kit.scanPass(template, { tier: secret });
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    await reviseReplayTemplate(template, (manifest) => {
      if (!manifest.inputs.properties) throw new Error('Missing input properties');
      manifest.inputs.properties.tier = { type: 'string', 'x-scan': 'manager' };
    });
    const response = await act(scanner.headers, codeOf(pass), { idempotencyKey });
    expect(response.status).toBe(200);
    const replay = await out(response);
    expectReceipt(replay, original);
    await expectOriginalLedger(pass.id, original.scanId);
    expect(JSON.stringify(replay)).not.toContain(secret);
  });

  it('returns the receipt but hides an action that now requires a higher role', async () => {
    const template = await kit.scanTemplate('Restricted replay action', { actions: [CHECK_IN] });
    await reviseReplayTemplate(template, () => {});
    const scanner = await kit.scanner({ templateIds: [template] });
    const pass = await kit.scanPass(template);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    await reviseReplayTemplate(template, (manifest) => {
      const action = manifest.scan?.actions[0];
      if (!action) throw new Error('Missing scan action');
      action.minRole = 'manager';
    });
    const response = await act(scanner.headers, codeOf(pass), { idempotencyKey });
    expect(response.status).toBe(200);
    const replay = await out(response);
    expectReceipt(replay, original);
    expect(replay.action).toBeNull();
    await expectOriginalLedger(pass.id, original.scanId);
    expect(
      await first(kit.env.DB, 'SELECT outcome FROM scans WHERE id = ?', [original.scanId ?? '']),
    ).toEqual({ outcome: 'ok' });
  });
}
