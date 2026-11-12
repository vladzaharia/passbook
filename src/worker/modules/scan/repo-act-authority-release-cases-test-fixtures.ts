import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { expectAdmitted, expectBlocked, raceGate } from './act-authority-test-fixtures.ts';
import {
  act,
  CHECK_IN,
  expectReceipt,
  expectRedactedReceipt,
  kit,
  out,
  reviseReplayTemplate,
  rows,
  tpl,
} from './act-test-fixtures.ts';
import { commitBatchSql } from './repo-act-support-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { codeOf, key } from './test-kit.ts';

export function registerAuthorityRelease() {
  it.each(['voided', 'expired'] as const)(
    'records an unchanged %s Wallet refusal without claiming a gate',
    async (state) => {
      const scanner = await kit.scanner({ templateIds: [tpl] });
      const pass = await kit.scanPass(tpl);
      const value = state === 'voided' ? true : new Date(kit.clock.now() - 1_000).toISOString();
      await run(
        kit.env.DB,
        'UPDATE pass_versions SET pass_json=json_set(pass_json,?,json(?)) WHERE pass_id=? AND version=?',
        [
          state === 'voided' ? '$.voided' : '$.expirationDate',
          JSON.stringify(value),
          pass.id,
          pass.version,
        ],
      );
      const response = await act(scanner.headers, codeOf(pass));
      expect(response.status).toBe(200);
      expect(await out(response)).toMatchObject({ kind: 'refused', reason: state });
      expect(await rows('SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id])).toHaveLength(
        0,
      );
      expect(
        await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.rejected'", [
          pass.id,
        ]),
      ).toHaveLength(1);
    },
  );

  it('does not admit when the pinned issuance release changes after evaluation', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(candidate?.pass.releaseId).toEqual(expect.any(String));
    const idempotencyKey = key();
    const response = await raceGate(
      scanner.headers,
      codeOf(pass),
      (db) => run(db, 'UPDATE passes SET release_id=NULL WHERE id=?', [pass.id]),
      { idempotencyKey },
    );
    await expectAdmitted(response, pass.id);
  });

  it('returns the receipt and admits an override after pinned issuance provenance changes', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl], settings: { letInAgain: 'anyone' } });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    const stopped = await out(await act(scanner.headers, codeOf(pass)));
    expect(stopped).toMatchObject({ kind: 'heads_up', reason: 'already_done' });
    await run(kit.env.DB, 'UPDATE passes SET release_id=NULL WHERE id=?', [pass.id]);
    expectRedactedReceipt(
      await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })),
      original,
    );
    // The release is content, not authority: the override is a new command and is admitted.
    expect(
      await out(await act(scanner.headers, codeOf(pass), { overrideOf: stopped.scanId })),
    ).toMatchObject({ kind: 'ok' });
  });

  // Liveness: a newer release between preflight and commit never refuses the ticket.
  for (const held of [false, true]) {
    for (const change of ['same version', 'away and back'] as const) {
      it(`admits ${held ? 'a held-gate heads-up' : 'the check-in'} after release ${change} at commit`, async () => {
        const template = await kit.scanTemplate('Release commit race', { actions: [CHECK_IN] });
        const scanner = await kit.scanner({ mode: 'test', templateIds: [template] });
        const pass = await kit.scanPass(template, {}, { mode: 'test' });
        const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
        if (!candidate?.activeReleaseVersion) throw new Error('Missing approved release');
        const activeReleaseVersion = candidate.activeReleaseVersion;
        if (held) expect((await out(await act(scanner.headers, codeOf(pass)))).kind).toBe('ok');
        const response = await raceGate(
          scanner.headers,
          codeOf(pass),
          async (db) => {
            if (change === 'away and back')
              await reviseReplayTemplate(template, () => {}, ['test'], db);
            await approveAppleRelease(kit, {
              templateId: template,
              db,
              mode: 'test',
              version: activeReleaseVersion,
            });
          },
          { idempotencyKey: key() },
          held ? commitBatchSql : 'INSERT INTO scan_gates',
        );
        expect(response.status).toBe(200);
        const outcome = await out(response);
        if (held) expect(outcome).toMatchObject({ kind: 'heads_up', reason: 'already_done' });
        else expect(outcome.kind).toBe('ok');
        expect(outcome.scanId).not.toBeNull();
        const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
        expect(current?.activeReleaseId).not.toBe(candidate.activeReleaseId);
        const events = await rows<{ kind: string }>(
          "SELECT kind FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%' ORDER BY id",
          [pass.id],
        );
        expect(events.map((event) => event.kind)).toEqual(
          held ? ['scan.checked_in', 'scan.heads_up'] : ['scan.checked_in'],
        );
        expect(
          await rows('SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id]),
        ).toHaveLength(1);
      });
    }
  }

  it.each(['same version', 'away and back'] as const)(
    'persists release lineage and returns the receipt after %s',
    async (change) => {
      const template = await kit.scanTemplate('Release replay', { actions: [CHECK_IN] });
      const scanner = await kit.scanner({ mode: 'test', templateIds: [template] });
      const pass = await kit.scanPass(template, {}, { mode: 'test' });
      const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!candidate?.activeReleaseVersion) throw new Error('Missing approved release');
      const idempotencyKey = key();
      const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
      expect(original.kind).toBe('ok');
      const event = await first<{ data: string }>(
        kit.env.DB,
        "SELECT data FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'",
        [pass.id],
      );
      if (!event) throw new Error('Missing scan event');
      expect(JSON.parse(event.data).authority).toMatchObject({
        pinnedReleaseId: candidate.pass.releaseId,
        activeReleaseId: candidate.activeReleaseId,
        activeReleaseGeneration: candidate.activeReleaseGeneration,
        activeReleaseVersion: candidate.activeReleaseVersion,
        activeReleaseCandidateHash: candidate.activeReleaseCandidateHash,
      });
      if (change === 'away and back') await reviseReplayTemplate(template, () => {}, ['test']);
      await approveAppleRelease(kit, {
        templateId: template,
        mode: 'test',
        version: candidate.activeReleaseVersion,
      });
      expectReceipt(
        await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })),
        original,
      );
    },
  );

  it('refuses with SCAN_CONFIG_CHANGED when the scanner role changes before commit (scanners.config_epoch)', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const response = await raceGate(
      scanner.headers,
      codeOf(pass),
      (db) => run(db, "UPDATE scanners SET device_role='monitor' WHERE id=?", [scanner.id]),
      { idempotencyKey },
    );
    await expectBlocked(response, pass.id, idempotencyKey, 'SCAN_CONFIG_CHANGED');
  });

  it('admits and records the scan once when the pass link generation changes before commit', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const response = await raceGate(
      scanner.headers,
      codeOf(pass),
      (db) => run(db, 'UPDATE passes SET link_generation=link_generation+1 WHERE id=?', [pass.id]),
      { idempotencyKey: key() },
    );
    await expectAdmitted(response, pass.id);
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'", [
        pass.id,
      ]),
    ).toHaveLength(1);
  });
}
