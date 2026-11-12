import { describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { activeRelease } from '../templates/releases.ts';
import {
  legacyPass,
  legacyVersions,
  session,
} from './repo-session-releases-split-test-fixtures.ts';
import { setupScanKit } from './test-kit.ts';

describe('scanner session approved releases', () => {
  it('projects the sole legacy pinned version rather than an unapproved active draft', async () => {
    const kit = await setupScanKit();
    const { id, pinned } = await legacyVersions(kit);
    const pass = await legacyPass(kit, pinned);
    await legacyPass(kit, pinned);
    expect(
      await first(
        kit.env.DB,
        'SELECT mode, template_version, release_id FROM passes WHERE id = ?',
        [pass.id],
      ),
    ).toEqual({ mode: 'live', template_version: 'v1', release_id: null });
    expect(
      await first(kit.env.DB, 'SELECT active_version FROM templates WHERE id = ?', [id]),
    ).toEqual({ active_version: 'v2' });
    expect((await kit.registry.resolve(id)).version).toBe('v2');
    expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).toBeNull();

    const event = await kit.event({ templateIds: [id] });
    const scanner = await kit.scanner({
      eventId: event.id,
      settings: { acceptAllTemplates: false },
    });
    const result = await session(kit, scanner.headers);
    expect(result).toMatchObject({
      state: 'ready',
      event: { id: event.id },
      scanner: {
        id: scanner.id,
        orgId: kit.org.id,
        mode: 'live',
        settings: { acceptAllTemplates: false },
      },
      formats: ['qr'],
    });
    expect(result.templates).toEqual([
      {
        id,
        name: 'Legacy version',
        style: 'generic',
        formats: ['qr'],
        actions: [{ id: 'legacy_entry', label: 'Legacy entry', kind: 'check_in' }],
      },
    ]);
  });

  it('redacts an ambiguous legacy scope instead of choosing a pinned version or active draft', async () => {
    const kit = await setupScanKit();
    const { id, pinned, draft, add } = await legacyVersions(kit);
    await add('v3', 'Newest draft', 'PKBarcodeFormatAztec', {
      id: 'newest_entry',
      label: 'Newest entry',
      kind: 'check_in',
    });
    await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', ['v3', id]);
    await legacyPass(kit, pinned);
    const event = await kit.event({ templateIds: [id] });
    const scan = await kit.scanner({
      eventId: event.id,
      deviceRole: 'scan',
      settings: { acceptAllTemplates: true },
    });
    const screens = await Promise.all(
      (['customer', 'monitor'] as const).map((deviceRole) =>
        kit.scanner({
          eventId: event.id,
          deviceRole,
          settings: { acceptAllTemplates: true },
        }),
      ),
    );

    const before = await session(kit, scan.headers);
    expect(before).toMatchObject({ state: 'ready', event: { id: event.id } });
    expect(before.templates).toMatchObject([{ id, name: 'Legacy version', formats: ['qr'] }]);
    const conflictingPass = await legacyPass(kit, draft);
    expect(
      await first(
        kit.env.DB,
        'SELECT mode, template_version, release_id FROM passes WHERE id = ?',
        [conflictingPass.id],
      ),
    ).toEqual({ mode: 'live', template_version: 'v2', release_id: null });
    expect((await kit.registry.resolve(id)).version).toBe('v3');
    expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).toBeNull();

    for (const scanner of [scan, ...screens]) {
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
  });

  it('only advertises the common actions and formats of multiple legacy pinned versions', async () => {
    const kit = await setupScanKit();
    const { id, pinned, add } = await legacyVersions(kit);
    const alternate = kit.registry.add({
      id,
      orgId: kit.org.id,
      version: 'v3',
      manifest: {
        ...pinned.manifest,
        name: 'Other legacy version',
        scan: {
          actions: [
            { id: 'legacy_entry', label: 'Legacy entry', kind: 'check_in' },
            { id: 'extra_entry', label: 'Extra entry', kind: 'check_in' },
          ],
        },
      },
      passJson: {
        ...pinned.passJson,
        barcodes: [
          { format: 'PKBarcodeFormatQR', message: '123456789', messageEncoding: 'iso-8859-1' },
          { format: 'PKBarcodeFormatPDF417', message: '123456789', messageEncoding: 'iso-8859-1' },
        ],
      },
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, alternate, { registry: kit.registry });
    await add('v4', 'Newest draft', 'PKBarcodeFormatAztec', {
      id: 'newest_entry',
      label: 'Newest entry',
      kind: 'check_in',
    });
    await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', ['v4', id]);
    await legacyPass(kit, pinned);
    await legacyPass(kit, alternate);
    expect((await kit.registry.resolve(id)).version).toBe('v4');
    expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).toBeNull();

    const event = await kit.event({ templateIds: [id] });
    const scanner = await kit.scanner({
      eventId: event.id,
      settings: { acceptAllTemplates: false },
    });
    const result = await session(kit, scanner.headers);
    expect(result).toMatchObject({
      state: 'ready',
      event: { id: event.id },
      scanner: { orgId: kit.org.id, mode: 'live', settings: { acceptAllTemplates: false } },
      formats: ['qr'],
    });
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]).toMatchObject({
      id,
      formats: ['qr'],
      actions: [{ id: 'legacy_entry', label: 'Legacy entry', kind: 'check_in' }],
    });
    expect(result.templates[0]?.name).not.toBe('Legacy version');
    expect(result.templates[0]?.name).not.toBe('Other legacy version');
    expect(result.templates[0]?.name).not.toBe('Newest draft');
    expect((await session(kit, scanner.headers)).templates).toEqual(result.templates);
  });

  it('does not advertise an identically named legacy action with different execution policy', async () => {
    const kit = await setupScanKit();
    const { id, pinned, add } = await legacyVersions(kit);
    const version = async (number: string, repeat: 'once' | 'always') => {
      const template = kit.registry.add({
        id,
        orgId: kit.org.id,
        version: number,
        manifest: {
          ...pinned.manifest,
          name: `Legacy policy ${number}`,
          scan: {
            actions: [
              { id: 'legacy_entry', label: 'Legacy entry', kind: 'check_in' },
              { id: 'risky_entry', label: 'Risky entry', kind: 'check_in', repeat },
            ],
          },
        },
        passJson: pinned.passJson,
        assets: { 'icon.png': ICON_PNG },
      });
      await persistTemplate(kit.fx, template, { registry: kit.registry });
      return template;
    };
    const firstPolicy = await version('v3', 'once');
    const secondPolicy = await version('v4', 'always');
    await add('v5', 'Newest draft', 'PKBarcodeFormatAztec', {
      id: 'draft_entry',
      label: 'Draft entry',
      kind: 'check_in',
    });
    await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', ['v5', id]);
    await legacyPass(kit, firstPolicy);
    await legacyPass(kit, secondPolicy);

    const scanner = await kit.scanner({
      templateIds: [id],
      settings: { acceptAllTemplates: true },
    });
    const result = await session(kit, scanner.headers);
    expect(result).toMatchObject({
      state: 'ready',
      scanner: { orgId: kit.org.id, mode: 'live', settings: { acceptAllTemplates: false } },
      formats: ['qr'],
    });
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]).toMatchObject({
      id,
      formats: ['qr'],
      actions: [{ id: 'legacy_entry', label: 'Legacy entry', kind: 'check_in' }],
    });
  });
});
