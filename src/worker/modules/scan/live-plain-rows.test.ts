import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
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

interface FixtureOptions {
  older?: boolean;
  photo?: boolean;
  templateId?: string;
  /** The source scanner's own scope; defaults to the template. */
  source?: { templateIds?: string[]; eventId?: string };
  /** The monitor's own scope. */
  monitor?: { templateIds?: string[]; eventId?: string };
  passInput?: Record<string, unknown>;
  wallet?: (passId: string) => Promise<void>;
}

async function fixture(options: FixtureOptions = {}) {
  const tpl = options.templateId ?? template;
  const source = await kit.scanner(options.source ?? { templateIds: [tpl] });
  const monitor = await screen('monitor', [source.id], false, {}, options.monitor);
  const pass = await kit.scanPass(tpl, { memberName: 'Plain Row Member', ...options.passInput });
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
  await options.wallet?.(pass.id);
  const event = row(source.id, { passId: pass.id });
  await publish(event);
  const shown = async () =>
    (await hub().snapshot(monitor.attachment, undefined, kit.clock.now())).rows.find(
      (item) => item.id === event.id,
    );
  const path = (await shown())?.photoUrl?.replace('/api/v1/scan', '') ?? '';
  const photoStatus = async () => (path ? (await kit.get(monitor.headers, path)).status : 404);
  return { source, monitor, pass, event, shown, path, photoStatus };
}

const freshTemplate = (name: string) =>
  kit.scanTemplate(name, { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] });

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
    await runInDurableObject(hub().stub, async (_object, state) => {
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
    await runInDurableObject(hub().stub, async (_object, state) => {
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

  it('redacts a row and refuses its photo when the monitor loses its own template', async () => {
    const f = await fixture({ monitor: { templateIds: [template] } });
    expect(await f.shown()).toMatchObject({ passId: f.pass.id });
    expect(await f.photoStatus()).toBe(200);
    const elsewhere = await freshTemplate('Monitor moved elsewhere');
    await run(kit.env.DB, 'UPDATE scanner_templates SET template_id = ? WHERE scanner_id = ?', [
      elsewhere,
      f.monitor.id,
    ]);
    // The change may also close the screen (nothing delivered); either way no identity.
    const after = await f.shown();
    expect(after === undefined || after.passId === null).toBe(true);
    expect(JSON.stringify(after ?? {})).not.toContain('Plain Row Member');
    expect(await f.photoStatus()).not.toBe(200);
  });

  it('shows no identity once the monitor event filter excludes the pass', async () => {
    const event = await kit.event({ templateIds: [template] });
    await run(kit.env.DB, 'UPDATE scan_events SET match_input = ?, match_values = ? WHERE id = ?', [
      'tier',
      '["gold"]',
      event.id,
    ]);
    const f = await fixture({
      source: { eventId: event.id },
      monitor: { eventId: event.id },
      passInput: { tier: 'gold' },
    });
    expect(await f.shown()).toMatchObject({ passId: f.pass.id });
    expect(await f.photoStatus()).toBe(200);
    await run(
      kit.env.DB,
      'UPDATE scan_events SET match_values = ?, updated_at = updated_at + 1 WHERE id = ?',
      ['["silver"]', event.id],
    );
    // The event's own epoch may close the screen (nothing) or the scope redacts the row.
    const after = await f.shown();
    expect(after === undefined || after.passId === null).toBe(true);
    expect(JSON.stringify(after ?? {})).not.toContain('Plain Row Member');
    expect(await f.photoStatus()).toBe(404);
  });

  it('redacts a row whose template is deleted after the scan', async () => {
    const own = await freshTemplate('Deleted after scan');
    const f = await fixture({ templateId: own });
    expect(await f.shown()).toMatchObject({ passId: f.pass.id });
    await run(kit.env.DB, "UPDATE templates SET status = 'deleted' WHERE id = ?", [own]);
    expect(await f.shown()).toMatchObject(REDACTED);
    expect(await f.photoStatus()).toBe(404);
  });

  it('stops showing identity and the photo once the Wallet expiry passes', async () => {
    const expiry = new Date(kit.clock.now() + 5_000).toISOString();
    const f = await fixture({
      wallet: async (passId) => {
        await run(
          kit.env.DB,
          "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?",
          [expiry, passId],
        );
      },
    });
    expect(await f.shown()).toMatchObject({ passId: f.pass.id, holder: 'Plain Row Member' });
    expect(await f.photoStatus()).toBe(200);
    // The hub reads the clock of the call that reaches it, so the kit clock decides.
    kit.clock.advance(7_000);
    expect(await f.shown()).toMatchObject(REDACTED);
    expect(await f.photoStatus()).toBe(404);
  });

  it('shows the row again when the effective release returns (release ABA)', async () => {
    const own = await freshTemplate('Release ABA');
    const f = await fixture({ older: true, templateId: own });
    const issued = await candidateById(kit.env.DB, kit.org.id, f.pass.id);
    if (!issued?.activeReleaseVersion) throw new Error('Missing release fixture.');
    expect(await f.shown()).toMatchObject({ passId: f.pass.id });
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: own,
      version: issued.activeReleaseVersion,
    });
    expect(await f.shown()).toMatchObject(REDACTED);
    // Archiving ends the head; the pass is again used under the release it was scanned under.
    await run(kit.env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [own]);
    expect(await f.shown()).toMatchObject({ passId: f.pass.id, holder: 'Plain Row Member' });
  });

  it('withholds the pass while its connection is disabled and shows it again when re-enabled', async () => {
    const connectionId = kit.ctx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
       VALUES (?, ?, 'demo', 'Plain row', 1, 1, 1)`,
      [connectionId, kit.org.id],
    );
    const f = await fixture({
      wallet: async (passId) => {
        await run(
          kit.env.DB,
          "UPDATE passes SET connection_id = ?, external_ref = 'plain-row' WHERE id = ?",
          [connectionId, passId],
        );
      },
    });
    expect(await f.shown()).toMatchObject({ passId: f.pass.id });
    await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [connectionId]);
    expect(await f.shown()).toMatchObject(REDACTED);
    expect(await f.photoStatus()).toBe(404);
    await run(kit.env.DB, 'UPDATE connections SET enabled = 1 WHERE id = ?', [connectionId]);
    expect(await f.shown()).toMatchObject({ passId: f.pass.id });
  });

  it('redacts a row whose scanned credential was retired by another pass transfer', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    const pass = await kit.scanPass(template, { memberName: 'Credential Member' });
    const ref = `${'a'.repeat(16)}${'b'.repeat(48)}`;
    const event = row(source.id, { passId: pass.id });
    await publish(event, [ref]);
    const shown = async () =>
      (await hub().snapshot(monitor.attachment)).rows.find((item) => item.id === event.id);
    expect(await shown()).toMatchObject({ passId: pass.id });
    expect(await hub().ringRow(event.id)).toMatchObject({ refPrefixes: ['a'.repeat(16)] });
    // Tombstones are written only by a transfer; this one is another pass's, so no generation moved.
    const trigger = await first<{ sql: string }>(
      kit.env.DB,
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'pass_credential_tombstones_insert_guard'",
    );
    if (!trigger?.sql) throw new Error('Missing tombstone guard trigger.');
    await run(kit.env.DB, 'DROP TRIGGER pass_credential_tombstones_insert_guard');
    try {
      await run(
        kit.env.DB,
        `INSERT INTO pass_credential_tombstones
         (pass_id, org_id, mode, credential_generation, credential_kind, credential_hash, retired_at)
         VALUES (?, ?, 'live', 1, 'barcode', ?, ?)`,
        [kit.ctx.ids.id(), kit.org.id, `${'a'.repeat(16)}${'0'.repeat(48)}`, kit.clock.now()],
      );
    } finally {
      await run(kit.env.DB, trigger.sql);
    }
    expect(await shown()).toMatchObject(REDACTED);
  });

  it('scrubs the holder name from storage once its pass is no longer visible', async () => {
    const f = await fixture();
    expect(await hub().ringRow(f.event.id)).toMatchObject({ row: { holder: 'Plain Row Member' } });
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [f.pass.id]);
    await publish(row(f.source.id));
    const stored = await hub().ringRow(f.event.id);
    expect(stored).toMatchObject({ gen: null, row: { holder: null, passId: null } });
    expect(JSON.stringify(stored)).not.toContain('Plain Row Member');
  });
});
