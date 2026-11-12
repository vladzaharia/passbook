import { describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { activeRelease } from '../templates/releases.ts';
import {
  attachWorkspace,
  duringTemplateRead,
  expectRedactedScope,
  expectScopedSession,
  scopedRaceScanner,
  session,
} from './repo-session-releases-split-test-fixtures.ts';
import { setupScanKit } from './test-kit.ts';

describe('scanner session approved releases', () => {
  it('retains the managed workspace for a valid empty unassigned scope', async () => {
    const kit = await setupScanKit();
    const scanner = await kit.scanner({
      settings: {
        acceptAllTemplates: false,
        defaultActionId: 'entry',
        checkIn: { mode: 'daily' },
        direction: 'in',
      },
    });
    const workspaceId = await attachWorkspace(kit, scanner.id, null);
    const result = await session(kit, scanner.headers);
    expect(result).toMatchObject({
      principal: 'scanner',
      state: 'unassigned',
      event: null,
      templates: [],
      formats: [],
      workspace: {
        session: { id: workspaceId, accepts: null },
        device: { id: scanner.id },
      },
      scanner: {
        id: scanner.id,
        orgId: kit.org.id,
        mode: 'live',
        timeZone: 'UTC',
        settings: {
          acceptAllTemplates: false,
          defaultActionId: 'entry',
          checkIn: { mode: 'daily' },
          direction: 'in',
        },
      },
      counts: { today: 0, event: null, asOf: kit.clock.now(), configRev: expect.any(Number) },
    });
  });

  it('redacts a managed workspace when its configured template scope is already invalid', async () => {
    const kit = await setupScanKit();
    const id = await kit.scanTemplate('Approved entry', {
      actions: [{ id: 'entry', label: 'Admit', kind: 'check_in' }],
    });
    const { event, scanner } = await scopedRaceScanner(kit, id, 'entry');
    expectScopedSession(await session(kit, scanner.headers), event.id, 'entry', kit.clock.now());

    const base = await kit.registry.resolve(id);
    const unapproved = kit.registry.add({
      id: `${id}-unapproved`,
      orgId: kit.org.id,
      version: 'v1',
      manifest: { ...base.manifest, name: 'Unapproved entry' },
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, unapproved, { registry: kit.registry });
    await run(
      kit.env.DB,
      'INSERT INTO scan_event_templates (event_id, template_id) VALUES (?, ?)',
      [event.id, unapproved.id],
    );
    const result = await session(kit, scanner.headers);
    expectRedactedScope(result, kit, scanner.id);
  });

  it('serves the captured release if the head changes while its template is being resolved', async () => {
    const kit = await setupScanKit();
    const id = await kit.scanTemplate('Initially approved', {
      actions: [{ id: 'entry', label: 'Admit', kind: 'check_in' }],
    });
    const base = await kit.registry.resolve(id);
    const replacement = kit.registry.add({
      id,
      orgId: kit.org.id,
      version: 'v2',
      manifest: {
        ...base.manifest,
        name: 'Replacement release',
        scan: { actions: [{ id: 'new_entry', label: 'New entry', kind: 'check_in' }] },
      },
      passJson: {
        ...base.passJson,
        barcodes: [
          { format: 'PKBarcodeFormatAztec', message: '123456789', messageEncoding: 'iso-8859-1' },
        ],
      },
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, replacement, { registry: kit.registry });
    const { event, scanner } = await scopedRaceScanner(kit, id, 'entry');
    expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).toMatchObject({
      version: 'v1',
    });
    expectScopedSession(await session(kit, scanner.headers), event.id, 'entry', kit.clock.now());

    const race = duringTemplateRead(kit, id, 'v1', async () => {
      await approveAppleRelease(kit, {
        orgId: kit.org.id,
        templateId: id,
        mode: 'live',
        version: 'v2',
      });
    });
    let result: Awaited<ReturnType<typeof session>>;
    try {
      result = await session(kit, scanner.headers);
    } finally {
      race.restore();
    }
    expect(race.state.fired).toBe(true);

    expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).toMatchObject({
      version: 'v2',
    });
    // The release head is content: the captured release row still exists, so the read stands.
    expectScopedSession(result, event.id, 'entry', kit.clock.now());
    expect(result.templates).toMatchObject([{ id, name: 'Initially approved' }]);

    const reloaded = await session(kit, scanner.headers);
    expect(reloaded).toMatchObject({
      state: 'ready',
      event: { id: event.id },
      scanner: { mode: 'live', settings: { acceptAllTemplates: false } },
    });
    expect(reloaded.templates).toEqual([
      {
        id,
        name: 'Replacement release',
        style: 'generic',
        formats: ['aztec'],
        actions: [{ id: 'new_entry', label: 'New entry', kind: 'check_in' }],
      },
    ]);
  });

  it.each(['revoked', 'settings changed'] as const)(
    'ends the read without scope if the scanner is %s while an approved template is resolving',
    async (change) => {
      const kit = await setupScanKit();
      const id = await kit.scanTemplate('Sensitive approved template', {
        actions: [{ id: 'entry', label: 'Admit', kind: 'check_in' }],
      });
      const event = await kit.event({ templateIds: [id] });
      const scanner = await kit.scanner({ eventId: event.id });
      const before = await session(kit, scanner.headers);
      expect(before).toMatchObject({
        state: 'ready',
        event: { id: event.id },
        scanner: { id: scanner.id, mode: 'live', settings: { flow: 'auto' } },
        templates: [{ id, name: 'Sensitive approved template' }],
      });

      const race = duringTemplateRead(kit, id, 'v1', async () => {
        const updated =
          change === 'revoked'
            ? await run(
                kit.env.DB,
                'UPDATE scanners SET revoked_at = ?, updated_at = updated_at + 1 WHERE id = ?',
                [kit.clock.now(), scanner.id],
              )
            : await run(
                kit.env.DB,
                `UPDATE scanners SET settings = json_set(settings, '$.flow', 'choose'),
                 updated_at = updated_at + 1 WHERE id = ?`,
                [scanner.id],
              );
        expect(updated.changes).toBeGreaterThanOrEqual(1);
      });
      let response: Response;
      try {
        response = await kit.get(scanner.headers, '/session');
      } finally {
        race.restore();
      }
      expect(race.state.fired).toBe(true);

      // Revocation unpairs (401); a settings change is a config change (409) and the device rereads.
      const status = change === 'revoked' ? 401 : 409;
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject(
        change === 'revoked'
          ? { status, code: 'SCANNER_UNAUTHENTICATED', detail: 'Pair this scanner to continue.' }
          : { status, code: 'SCAN_CONFIG_CHANGED' },
      );
      for (const field of ['state', 'scanner', 'event', 'templates', 'formats', 'csrfToken']) {
        expect(body).not.toHaveProperty(field);
      }
      expect(JSON.stringify(body)).not.toContain('Sensitive approved template');

      if (change === 'settings changed') {
        const reloaded = await session(kit, scanner.headers);
        expect(reloaded).toMatchObject({
          state: 'ready',
          event: { id: event.id },
          scanner: { id: scanner.id, settings: { flow: 'choose' } },
        });
      }
    },
  );
});
