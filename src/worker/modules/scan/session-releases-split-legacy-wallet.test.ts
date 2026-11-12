import { describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { activeRelease } from '../templates/releases.ts';
import {
  duringTemplateRead,
  expectRedactedScope,
  expectScopedSession,
  legacyPass,
  legacyVersions,
  scopedRaceScanner,
  session,
} from './repo-session-releases-split-test-fixtures.ts';
import { setupScanKit } from './test-kit.ts';

describe('scanner session approved releases', () => {
  it('fails closed if a legacy signing identity changes away and back during projection', async () => {
    const kit = await setupScanKit();
    const { id, pinned } = await legacyVersions(kit);
    const pass = await legacyPass(kit, pinned);
    const { event, scanner } = await scopedRaceScanner(kit, id, 'legacy_entry');
    const identity = await first<{ id: string; pass_type_identifier: string; revision: number }>(
      kit.env.DB,
      `SELECT i.id, i.pass_type_identifier, i.revision FROM signing_identities i
       JOIN passes p ON p.identity_id = i.id WHERE p.id = ?`,
      [pass.id],
    );
    if (!identity) throw new Error('Expected the legacy pass signing identity');
    expect(identity.revision).toBeGreaterThan(0);
    const before = await session(kit, scanner.headers);
    expectScopedSession(before, event.id, 'legacy_entry', kit.clock.now());
    expect(before.templates).toMatchObject([{ id, name: 'Legacy version' }]);

    let changedRevision = 0;
    const race = duringTemplateRead(kit, id, 'v1', async () => {
      await run(kit.env.DB, 'UPDATE signing_identities SET pass_type_identifier = ? WHERE id = ?', [
        `${identity.pass_type_identifier}.changed`,
        identity.id,
      ]);
      const changed = await first<{ revision: number }>(
        kit.env.DB,
        'SELECT revision FROM signing_identities WHERE id = ?',
        [identity.id],
      );
      if (!changed) throw new Error('Expected the changed signing identity');
      changedRevision = changed.revision;
      expect(changedRevision).toBeGreaterThan(identity.revision);
      await run(kit.env.DB, 'UPDATE signing_identities SET pass_type_identifier = ? WHERE id = ?', [
        identity.pass_type_identifier,
        identity.id,
      ]);
    });
    let result: Awaited<ReturnType<typeof session>>;
    try {
      result = await session(kit, scanner.headers);
    } finally {
      race.restore();
    }
    expect(race.state.fired).toBe(true);

    const restored = await first<{ pass_type_identifier: string; revision: number }>(
      kit.env.DB,
      'SELECT pass_type_identifier, revision FROM signing_identities WHERE id = ?',
      [identity.id],
    );
    if (!restored) throw new Error('Expected the restored signing identity');
    expect(restored.pass_type_identifier).toBe(identity.pass_type_identifier);
    expect(restored.revision).toBeGreaterThan(changedRevision);
    expectRedactedScope(result, kit, scanner.id);

    const reloaded = await session(kit, scanner.headers);
    expect(reloaded).toMatchObject({
      state: 'ready',
      event: { id: event.id },
      scanner: { mode: 'live', settings: { acceptAllTemplates: false } },
    });
    expect(reloaded.templates).toEqual([
      {
        id,
        name: 'Legacy version',
        style: 'generic',
        formats: ['qr'],
        actions: [{ id: 'legacy_entry', label: 'Legacy entry', kind: 'check_in' }],
      },
    ]);
  });

  it('rejects an empty legacy pinned version instead of resolving the registry default', async () => {
    const kit = await setupScanKit();
    const id = `tpl-empty-version-${kit.fx.ids.token(6)}`;
    const empty = kit.registry.add({
      id,
      orgId: kit.org.id,
      version: '',
      manifest: {
        ...kit.template.manifest,
        name: 'Empty legacy version',
        scan: { actions: [{ id: 'legacy', label: 'Legacy', kind: 'check_in' }] },
      },
      passJson: kit.template.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, empty, { registry: kit.registry });
    const draft = kit.registry.add({
      id,
      orgId: kit.org.id,
      version: 'v2',
      manifest: {
        ...kit.template.manifest,
        name: 'Unapproved default draft',
        scan: { actions: [{ id: 'draft', label: 'Draft', kind: 'check_in' }] },
      },
      passJson: {
        ...kit.template.passJson,
        barcodes: [
          { format: 'PKBarcodeFormatAztec', message: '123456789', messageEncoding: 'iso-8859-1' },
        ],
      },
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, draft, { registry: kit.registry });
    await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', ['v2', id]);
    const pass = await legacyPass(kit, empty);
    expect(
      await first(kit.env.DB, 'SELECT template_version, release_id FROM passes WHERE id = ?', [
        pass.id,
      ]),
    ).toEqual({ template_version: '', release_id: null });
    expect((await kit.registry.resolve(id)).version).toBe('v2');
    expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).toBeNull();

    const event = await kit.event({ templateIds: [id] });
    for (const deviceRole of ['scan', 'customer', 'monitor'] as const) {
      const scanner = await kit.scanner({
        eventId: event.id,
        deviceRole,
        settings: { acceptAllTemplates: true },
      });
      const result = await session(kit, scanner.headers);
      expect(result).toMatchObject({
        state: 'unassigned',
        workspace: null,
        event: null,
        templates: [],
        formats: [],
        scanner: {
          id: scanner.id,
          orgId: kit.org.id,
          mode: 'live',
          deviceRole,
          settings: { acceptAllTemplates: false },
        },
      });
    }
  });

  it('requires the current legacy Wallet snapshot to be a valid object with the correct identity', async () => {
    const kit = await setupScanKit();
    const { id, pinned } = await legacyVersions(kit);
    const pass = await legacyPass(kit, pinned);
    const event = await kit.event({ templateIds: [id] });
    const scanner = await kit.scanner({
      eventId: event.id,
      settings: { acceptAllTemplates: true },
    });
    const original = await first<{ pass_json: string }>(
      kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? AND version = 1',
      [pass.id],
    );
    if (!original?.pass_json) throw new Error('Expected the original Wallet snapshot');
    const valid = JSON.parse(original.pass_json) as Record<string, unknown>;

    // Publish a second current snapshot while retaining the older valid version.
    // An invalid current snapshot must not fall back to that earlier JSON.
    const objectKey = `${pass.objectKey}-second`;
    await kit.env.BUCKET.put(objectKey, new Uint8Array([1, 2, 3]));
    await run(
      kit.env.DB,
      `UPDATE passes SET version = version + 1, object_key = ?, pending_pass_json = ?, modified_at = ?
       WHERE id = ?`,
      [objectKey, original.pass_json, kit.clock.now(), pass.id],
    );
    const before = await session(kit, scanner.headers);
    expect(before).toMatchObject({
      state: 'ready',
      event: { id: event.id },
      templates: [{ id, name: 'Legacy version' }],
    });

    for (const snapshot of [
      null,
      '{invalid',
      '[]',
      '{}',
      JSON.stringify({ ...valid, serialNumber: 'different-serial' }),
      JSON.stringify({ ...valid, passTypeIdentifier: 'pass.different' }),
      JSON.stringify({ ...valid, teamIdentifier: 'different-team' }),
    ]) {
      await run(
        kit.env.DB,
        'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ? AND version = 2',
        [snapshot, pass.id],
      );
      const result = await session(kit, scanner.headers);
      expect(result).toMatchObject({
        state: 'unassigned',
        workspace: null,
        event: null,
        templates: [],
        formats: [],
        scanner: {
          id: scanner.id,
          orgId: kit.org.id,
          mode: 'live',
          settings: { acceptAllTemplates: false },
        },
      });
    }

    // Scope visibility does not hide valid Wallet snapshots merely because their
    // passes will be refused as voided or expired when actually scanned.
    for (const status of [{ voided: true }, { expirationDate: '2000-01-01T00:00:00Z' }]) {
      await run(
        kit.env.DB,
        'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ? AND version = 2',
        [JSON.stringify({ ...valid, ...status }), pass.id],
      );
      const result = await session(kit, scanner.headers);
      expect(result).toMatchObject({
        state: 'ready',
        event: { id: event.id },
        templates: [{ id, name: 'Legacy version' }],
      });
    }
  });
});
