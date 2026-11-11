import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import {
  actions,
  duplicateEvent,
  expectInvalid,
  kit,
  request,
  type Scenario,
  scenario,
  setupOverrideProof,
  state,
  templateId,
} from './repo-act-override-proof-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupOverrideProof);

describe('override event provenance', () => {
  it.each([false, true])('commits one authenticated override (legacy=%s)', async (legacy) => {
    const s = await scenario({ legacy });
    const data = JSON.parse(s.event.data);
    expect(data.authority.eventProof).toMatchObject({
      releaseClass: legacy ? 'legacy' : 'approved',
      mac: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(data.actionIdRef).toMatch(/^[0-9a-f]{64}$/);
    expect(data).not.toHaveProperty('actionId');

    const response = await request(s.scanner, s.input, { overrideOf: s.headsId });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ScanOutcome;
    expect(result).toMatchObject({ kind: 'ok', replay: false, scanId: expect.any(String) });
    expect(
      await first(kit.env.DB, 'SELECT override_of,action_id FROM scans WHERE id=?', [
        result.scanId,
      ]),
    ).toEqual({ override_of: s.headsId, action_id: 'check_in' });
    expect(
      await first(
        kit.env.DB,
        'SELECT count,last_scan_id FROM scan_gates WHERE pass_id=? AND action_id=?',
        [s.pass.id, 'check_in'],
      ),
    ).toEqual({ count: 2, last_scan_id: result.scanId });
    await expectInvalid(s);
  });

  it.each([
    ['action reference', '$.actionIdRef', 'f'.repeat(64)],
    ['gate count', '$.authority.gate.count', 999],
    ['release generation', '$.authority.activeReleaseGeneration', 999999],
    ['credential generation', '$.authority.credentialGeneration', 999999],
    ['lifecycle generation', '$.authority.lifecycleGeneration', 999999],
    ['transfer guard', '$.authority.noPendingTransfer', 0],
    ['nonquarantine', '$.authority.nonQuarantined', 0],
  ])('rejects an inconsistent recorded %s before any gate claim', async (_name, path, value) => {
    const s = await scenario();
    await run(kit.env.DB, 'UPDATE pass_events SET data=json_set(data,?,?) WHERE id=?', [
      path,
      value,
      s.event.id,
    ]);
    await expectInvalid(s);
  });

  it.each([
    '$.actionIdRef',
    '$.authority.effect',
    '$.authority.credentialGeneration',
    '$.authority.lifecycleGeneration',
    '$.authority.noPendingTransfer',
  ])('rejects missing recorded field %s before any gate claim', async (path) => {
    const s = await scenario();
    await run(kit.env.DB, 'UPDATE pass_events SET data=json_remove(data,?) WHERE id=?', [
      path,
      s.event.id,
    ]);
    await expectInvalid(s);
  });

  it('accepts a row without proof fields', async () => {
    const s = await scenario();
    const row = await first<{ data: string }>(
      kit.env.DB,
      'SELECT data FROM pass_events WHERE id=?',
      [s.event.id],
    );
    const authority = JSON.parse(row?.data ?? '{}').authority;
    for (const field of [
      'eventProof',
      'credentialKeysetCommitment',
      'scannerCsrfProof',
      'sessionCsrfProof',
    ])
      expect(authority).not.toHaveProperty(field);
  });

  it('rejects an action substitution even when the requested action matches the forged scan', async () => {
    const s = await scenario();
    await run(kit.env.DB, "UPDATE scans SET action_id='other' WHERE id=?", [s.headsId]);
    await expectInvalid(s, { actionId: 'other' });
  });

  it('rejects an empty stored action ID as invalid proof', async () => {
    const s = await scenario();
    await run(kit.env.DB, "UPDATE scans SET action_id='' WHERE id=?", [s.headsId]);
    await expectInvalid(s);
  });

  it.each(['missing', 'malformed', 'duplicate', 'cross-mode', 'cross-pass', 'cross-org'] as const)(
    'rejects %s original event without a gate claim',
    async (change) => {
      const s = await scenario();
      if (change === 'missing')
        await run(kit.env.DB, 'DELETE FROM pass_events WHERE id=?', [s.event.id]);
      else if (change === 'malformed')
        await run(kit.env.DB, "UPDATE pass_events SET data='{}' WHERE id=?", [s.event.id]);
      else if (change === 'duplicate') await duplicateEvent(kit.env.DB, s.event.id);
      else if (change === 'cross-mode')
        await run(kit.env.DB, "UPDATE pass_events SET mode='test' WHERE id=?", [s.event.id]);
      else if (change === 'cross-pass') {
        const other = await kit.scanPass(templateId);
        await run(kit.env.DB, 'UPDATE pass_events SET pass_id=? WHERE id=?', [
          other.id,
          s.event.id,
        ]);
      } else {
        const org = await makeOrg(kit.fx);
        await run(kit.env.DB, 'UPDATE pass_events SET org_id=? WHERE id=?', [org.id, s.event.id]);
      }
      await expectInvalid(s);
    },
  );

  it('does not accept another organization’s signed heads-up as the override target', async () => {
    const original = await scenario();
    const org = await makeOrg(kit.fx);
    const otherTemplate = await kit.scanTemplate(
      'Other org override',
      { actions: [...actions] },
      { orgId: org.id },
    );
    const pass = await kit.scanPass(otherTemplate, {}, { orgId: org.id });
    const scanner = await kit.scanner({
      orgId: org.id,
      templateIds: [otherTemplate],
      settings: { letInAgain: 'anyone' },
    });
    const other: Scenario = { ...original, scanner, pass, input: codeOf(pass) };
    const before = await state(original.pass.id);
    await expectInvalid(other);
    expect(await state(original.pass.id)).toEqual(before);
  });

  it('still requires a current manager approval for an authenticated heads-up', async () => {
    const manager = await kit.staff('manager');
    const s = await scenario({ letInAgain: 'manager' });
    const before = await state(s.pass.id);
    const denied = await request(s.scanner, s.input, { overrideOf: s.headsId });
    expect(denied.status).toBe(200);
    expect(await denied.json()).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
    expect(await state(s.pass.id)).toEqual(before);
    const approved = await request(s.scanner, s.input, {
      overrideOf: s.headsId,
      approval: { staffId: manager.id, pin: manager.pin },
    });
    expect(approved.status).toBe(200);
    const result = (await approved.json()) as ScanOutcome;
    expect(result.kind).toBe('ok');
    expect(
      await first(kit.env.DB, 'SELECT approved_by FROM scans WHERE id=?', [result.scanId]),
    ).toEqual({ approved_by: manager.id });
  });
});
