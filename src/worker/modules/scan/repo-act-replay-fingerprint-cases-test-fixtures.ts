import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { setArchived } from '../templates/lifecycle.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import {
  act,
  CHECK_IN,
  expectOriginalLedger,
  expectReceipt,
  expectRedactedReceipt,
  expectUnavailable,
  kit,
  out,
  tpl,
} from './act-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { codeOf, key } from './test-kit.ts';

export function registerReplayFingerprint() {
  it('records a keyed pass JSON fingerprint and redacts a later semantic replacement', async () => {
    const secret = 'PRIVATE-PASS-JSON-FINGERPRINT';
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl, { memberName: secret });
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    const snapshot = await first<{ pass_json: string }>(
      kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? AND version <= ? ORDER BY version DESC LIMIT 1',
      [pass.id, pass.version],
    );
    const ledger = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_in'",
      [pass.id],
    );
    expect(snapshot).not.toBeNull();
    if (!snapshot || !ledger) throw new Error('Missing pass snapshot or scan event');
    const digest = JSON.parse(ledger.data).authority.passJsonHash;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(await sha256Hex(canonicalJson(JSON.parse(snapshot.pass_json))));
    expect(ledger.data).not.toContain(secret);
    expect(ledger.data).not.toContain(pass.serial);
    if (pass.scanCode === null) throw new Error('Missing pass scan code');
    expect(ledger.data).not.toContain(pass.scanCode);
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.description', 'changed')
      WHERE pass_id = ? AND version = (SELECT MAX(version) FROM pass_versions WHERE pass_id = ? AND version <= ?)`,
      [pass.id, pass.id, pass.version],
    );
    expectRedactedReceipt(
      await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })),
      original,
    );
    await expectOriginalLedger(pass.id, original.scanId);
  });

  it('accepts an encoding-only pass JSON change under the same canonical fingerprint', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    const snapshot = await first<{ pass_json: string }>(
      kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? AND version <= ? ORDER BY version DESC LIMIT 1',
      [pass.id, pass.version],
    );
    expect(snapshot).not.toBeNull();
    if (!snapshot) throw new Error('Missing pass snapshot');
    const reformatted = JSON.stringify(JSON.parse(snapshot.pass_json), null, 2);
    expect(reformatted).not.toBe(snapshot.pass_json);
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET pass_json = ?
      WHERE pass_id = ? AND version = (SELECT MAX(version) FROM pass_versions WHERE pass_id = ? AND version <= ?)`,
      [reformatted, pass.id, pass.id, pass.version],
    );
    const replay = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expectReceipt(replay, original);
    await expectOriginalLedger(pass.id, original.scanId);
  });

  it('fails closed when the bounded latest pass JSON is purged despite older and future rows', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    for (const version of [pass.version - 1, pass.version + 1]) {
      await run(
        kit.env.DB,
        `INSERT INTO pass_versions
        (pass_id,version,object_key,object_sha256,template_version,personalization,pass_json,cause,actor_type,actor_id,created_at,purged_at)
        SELECT pass_id,?,object_key,object_sha256,template_version,personalization,pass_json,cause,actor_type,actor_id,created_at,NULL
        FROM pass_versions WHERE pass_id = ? AND version = ?`,
        [version, pass.id, pass.version],
      );
    }
    await run(
      kit.env.DB,
      'UPDATE pass_versions SET pass_json = NULL, purged_at = ? WHERE pass_id = ? AND version = ?',
      [kit.clock.now(), pass.id, pass.version],
    );
    expectRedactedReceipt(
      await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })),
      original,
    );
    expectUnavailable(await out(await act(scanner.headers, codeOf(pass))));
    await expectOriginalLedger(pass.id, original.scanId);
  });

  it('refuses both the replay and a new command when the template is archived and its release head is unavailable', async () => {
    const template = await kit.scanTemplate('Unavailable release replay', { actions: [CHECK_IN] });
    const release = await approveAppleRelease(kit, {
      templateId: template,
      mode: 'live',
      version: 'v1',
    });
    const scanner = await kit.scanner({ templateIds: [template] });
    const pass = await kit.scanPass(template, { memberName: 'Head Unavailable Secret' });
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    // The template is private to this test, so it stays archived: restoring one with an approved
    // Live head now requires a rollback release.
    await setArchived(kit.ctx, release.publisherAuth, template, true);
    expect(await candidateById(kit.env.DB, kit.org.id, pass.id)).toMatchObject({
      pass: { releaseId: release.id },
      activeReleaseId: null,
      activeTemplateVersion: null,
    });
    // An archived template leaves the scanner's scope, so the key's replay and a new command are
    // both the same bare not_accepted refusal (the receipt is no longer served).
    const replay = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expectUnavailable(replay, 'not_accepted');
    expect(JSON.stringify(replay)).not.toContain('Head Unavailable Secret');
    expectUnavailable(await out(await act(scanner.headers, codeOf(pass))), 'not_accepted');
    await expectOriginalLedger(pass.id, original.scanId);
  });

  it('masks a replay when the pass JSON fingerprint field is missing', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    await run(
      kit.env.DB,
      `UPDATE pass_events SET data = json_remove(data, '$.authority.passJsonHash')
      WHERE pass_id = ? AND kind = 'scan.checked_in'`,
      [pass.id],
    );
    expectUnavailable(await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })));
    await expectOriginalLedger(pass.id, original.scanId);
  });

  it.each([
    ['identityId', 'missing'],
    ['identityPassTypeIdentifier', 'missing'],
    ['identityTeamIdentifier', 'missing'],
    ['identityRevision', 'missing'],
    ['identityRevision', 'mismatched'],
  ] as const)('masks replay with %s %s provenance', async (field, change) => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    const ledger = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_in'",
      [pass.id],
    );
    if (!ledger) throw new Error('Missing scan event');
    expect(JSON.parse(ledger.data).authority[field]).toEqual(
      field === 'identityRevision' ? expect.any(Number) : expect.any(String),
    );
    const path = `$.authority.${field}`;
    const mutate =
      change === 'missing'
        ? 'json_remove(data, ?)'
        : field === 'identityRevision'
          ? 'json_set(data, ?, -1)'
          : "json_set(data, ?, 'UNRELATED-IDENTIFIER')";
    await run(
      kit.env.DB,
      `UPDATE pass_events SET data = ${mutate} WHERE pass_id = ? AND kind = 'scan.checked_in'`,
      [path, pass.id],
    );
    expectUnavailable(await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })));
    await expectOriginalLedger(pass.id, original.scanId);
  });

  it('redacts a receipt after a signing-identity team A→B→A change', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const original = await out(await act(scanner.headers, codeOf(pass), { idempotencyKey }));
    expect(original.kind).toBe('ok');
    const identity = await first<{ team_identifier: string; revision: number }>(
      kit.env.DB,
      'SELECT team_identifier, revision FROM signing_identities WHERE id = ?',
      [pass.identityId],
    );
    if (!identity) throw new Error('Missing signing identity');
    try {
      await run(kit.env.DB, 'UPDATE signing_identities SET team_identifier = ? WHERE id = ?', [
        `${identity.team_identifier}-changed`,
        pass.identityId,
      ]);
    } finally {
      await run(kit.env.DB, 'UPDATE signing_identities SET team_identifier = ? WHERE id = ?', [
        identity.team_identifier,
        pass.identityId,
      ]);
    }
    const current = await first<{ team_identifier: string; revision: number }>(
      kit.env.DB,
      'SELECT team_identifier, revision FROM signing_identities WHERE id = ?',
      [pass.identityId],
    );
    expect(current?.team_identifier).toBe(identity.team_identifier);
    if (!current) throw new Error('Missing signing identity');
    expect(current.revision).toBeGreaterThan(identity.revision);
    expectRedactedReceipt(
      await out(await act(scanner.headers, codeOf(pass), { idempotencyKey })),
      original,
    );
    await expectOriginalLedger(pass.id, original.scanId);
  });
}
