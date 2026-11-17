import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { act } from './act.ts';
import { scannerActor, withRole } from './actor.ts';
import { publishScan } from './live.ts';
import type { LiveRingRow } from './live-ring.ts';
import { issueUnderOlderAdapter } from './release-policy-test-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import {
  beginCredentialTransfer,
  hub,
  kit,
  proven,
  publish,
  row,
  screen,
  template,
} from './scan-hub-test-fixtures.ts';
import { codeOf, key, proofedScanActor } from './test-kit.ts';

/*
 * The plain-row rule: a live row is shown to a recipient as the source screen showed it while (1) the
 * recipient's own authority holds, (2) the scan is still a finished, retained scan of that pass, and
 * (3) the pass is live at the credential and lifecycle generations the scan saw, under the release it
 * was used under, inside the recipient's scope. Content-only changes are not authority. Any part of
 * (2) or (3) failing delivers the redacted shape; (1) failing delivers nothing.
 */

const REDACTED = { passId: null, holder: null, photoUrl: null };

async function fixture(options: { older?: boolean; photo?: boolean } = {}) {
  const source = await kit.scanner({ templateIds: [template] });
  const monitor = await screen('monitor', [source.id]);
  const pass = await kit.scanPass(template, { memberName: 'Plain Row Member' });
  if (options.older) await issueUnderOlderAdapter(kit, pass.id);
  if (options.photo !== false) {
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
  }
  const event = row(source.id, { passId: pass.id });
  await publish(event);
  const shown = async () =>
    (await hub().snapshot(monitor.attachment)).rows.find((item) => item.id === event.id);
  return { source, monitor, pass, event, shown };
}

describe('live plain rows', () => {
  it('shows the holder, pass and photo while everything is current (positive control)', async () => {
    const f = await fixture();
    expect(await f.shown()).toMatchObject({
      passId: f.pass.id,
      holder: 'Plain Row Member',
      photoUrl: expect.stringContaining('/live/passes/'),
    });
  });

  it.each([
    ['deleted', 'deleted_at = 1'],
    ['voided', "status = 'voided'"],
    ['removed', 'removed_at = 1'],
    ['quarantined', 'test_data_quarantined = 1'],
    ['lifecycle moved', 'lifecycle_generation = lifecycle_generation + 1'],
  ])('redacts the row when the pass is %s after the scan', async (_state, change) => {
    const f = await fixture();
    expect(await f.shown()).toMatchObject({ passId: f.pass.id });
    await run(kit.env.DB, `UPDATE passes SET ${change} WHERE id = ?`, [f.pass.id]);
    const after = await f.shown();
    expect(after).toMatchObject(REDACTED);
    expect(JSON.stringify(after)).not.toContain('Plain Row Member');
  });

  it('redacts the row for a pass transferred after the scan, and keeps it redacted', async () => {
    const f = await fixture();
    const finish = await beginCredentialTransfer(f.pass.id);
    expect(await f.shown()).toMatchObject(REDACTED);
    await finish();
    expect(await f.shown()).toMatchObject(REDACTED);
  });

  it('redacts the row when its scan is excluded from the retained ledger', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    const device = await getScanner(kit.env.DB, source.id);
    if (!device) throw new Error('Missing source scanner.');
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(kit.ctx, device, 'live', 'cookie', { event: null, templateIds: [template] }),
        null,
      ),
    );
    const pass = await kit.scanPass(template, { memberName: 'Ledger Member' });
    const { outcome, evaluatedSnapshot, credentialContext } = await act(kit.ctx, actor, {
      input: codeOf(pass),
      actionId: 'check_in',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    expect(outcome.kind).toBe('ok');
    publishScan(kit.ctx, actor, outcome, evaluatedSnapshot, credentialContext, 'camera');
    await kit.settle();
    const rows = () =>
      hub()
        .snapshot(monitor.attachment)
        .then((s) => s.rows);
    const [shown] = await rows();
    expect(shown).toMatchObject({ passId: pass.id, holder: 'Ledger Member' });
    expect(await hub().ringRow(shown?.id ?? '')).toMatchObject({ scanId: outcome.scanId });
    await run(kit.env.DB, 'INSERT INTO scan_quarantine_exclusions (scan_id) VALUES (?)', [
      outcome.scanId,
    ]);
    expect((await rows())[0]).toMatchObject(REDACTED);
  });

  it('withholds the photo and keeps the row when only the image changed', async () => {
    const f = await fixture();
    await run(kit.env.DB, 'UPDATE member_photos SET updated_at = updated_at WHERE pass_id = ?', [
      f.pass.id,
    ]);
    expect(await f.shown()).toMatchObject({ passId: f.pass.id, photoUrl: null });
  });

  it('does not treat content-only changes as authority', async () => {
    const f = await fixture();
    await run(
      kit.env.DB,
      `UPDATE passes SET personalization = json_set(personalization, '$.memberName', 'Edited'),
         version = version + 1, revision = revision + 1 WHERE id = ?`,
      [f.pass.id],
    );
    expect(await f.shown()).toMatchObject({ passId: f.pass.id, holder: 'Plain Row Member' });
  });

  it('keeps the row across an identical republish and redacts it under another adapter', async () => {
    const same = await fixture();
    const before = await candidateById(kit.env.DB, kit.org.id, same.pass.id);
    if (!before?.activeReleaseVersion) throw new Error('Missing release fixture.');
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: template,
      version: before.activeReleaseVersion,
    });
    expect(await same.shown()).toMatchObject({ passId: same.pass.id });

    const older = await fixture({ older: true });
    const issued = await candidateById(kit.env.DB, kit.org.id, older.pass.id);
    if (!issued?.activeReleaseVersion) throw new Error('Missing older release fixture.');
    expect(await older.shown()).toMatchObject({ passId: older.pass.id });
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: template,
      version: issued.activeReleaseVersion,
    });
    expect(await older.shown()).toMatchObject(REDACTED);
  });

  it('delivers nothing once the recipient is revoked, and redacts a foreign tenant pass', async () => {
    const f = await fixture();
    const foreignOrg = await makeOrg(kit.fx, { name: 'Plain row foreign tenant' });
    const foreignTemplate = await kit.scanTemplate(
      'Foreign plain row',
      { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] },
      { orgId: foreignOrg.id },
    );
    const foreign = await kit.scanPass(foreignTemplate, {}, { orgId: foreignOrg.id });
    const ring = await hub().ringRow(f.event.id);
    if (!ring) throw new Error('Missing ring entry.');
    const crafted: LiveRingRow = {
      ...ring,
      row: { ...ring.row, id: kit.ctx.ids.token(16), passId: foreign.id },
    };
    await runInDurableObject(hub(), async (_object, state) => {
      await state.storage.put('recent', [ring, crafted]);
    });
    const rows = (await hub().snapshot(f.monitor.attachment)).rows;
    expect(rows.find((item) => item.id === ring.row.id)).toMatchObject({ passId: f.pass.id });
    expect(rows.find((item) => item.id === crafted.row.id)).toMatchObject(REDACTED);
    await run(kit.env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      f.monitor.id,
    ]);
    expect((await hub().snapshot(f.monitor.attachment)).rows).toEqual([]);
  });

  it('redacts a pass of another mode', async () => {
    const f = await fixture();
    const testPass = await kit.scanPass(template, {}, { mode: 'test' });
    const ring = await hub().ringRow(f.event.id);
    if (!ring) throw new Error('Missing ring entry.');
    const crafted: LiveRingRow = {
      ...ring,
      row: { ...ring.row, id: kit.ctx.ids.token(16), passId: testPass.id },
    };
    await runInDurableObject(hub(), async (_object, state) => {
      await state.storage.put('recent', [crafted]);
    });
    expect((await hub().snapshot(f.monitor.attachment)).rows).toMatchObject([REDACTED]);
  });

  it('refuses to build an entry for a pass the source could not evaluate', async () => {
    const f = await fixture();
    await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = NULL WHERE pass_id = ?', [
      f.pass.id,
    ]);
    await expect(proven(row(f.source.id, { passId: f.pass.id }))).rejects.toThrow(
      'The source pass cannot be shown.',
    );
  });
});
