import { describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { ScanAction } from '../../../passkit/types.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { session } from './repo-session-releases-split-test-fixtures.ts';
import { setupScanKit } from './test-kit.ts';

describe('scanner session approved releases', () => {
  it('projects each mode’s explicit approved version instead of the registry default', async () => {
    const kit = await setupScanKit();
    const id = await kit.scanTemplate('Original version', {
      actions: [{ id: 'original', label: 'Original', kind: 'check_in' }],
    });
    const base = await kit.registry.resolve(id);
    const liveAction = { id: 'live_entry', label: 'Live entry', kind: 'check_in' } as const;
    const testAction = { id: 'test_credit', label: 'Test credit', kind: 'add' } as const;
    const draftAction = { id: 'draft_entry', label: 'Draft entry', kind: 'check_in' } as const;

    const addVersion = async (
      version: string,
      name: string,
      action: ScanAction,
      format: string,
    ) => {
      const resolved = kit.registry.add({
        id,
        orgId: kit.org.id,
        version,
        manifest: {
          ...base.manifest,
          name,
          sample: { ...base.manifest.sample, balance: 10 },
          scan: { actions: [action] },
        },
        passJson: {
          ...base.passJson,
          barcodes: [{ format, message: '123456789', messageEncoding: 'iso-8859-1' }],
        },
        assets: { 'icon.png': ICON_PNG },
      });
      await persistTemplate(kit.fx, resolved, { registry: kit.registry });
    };
    await addVersion('v2', 'Live approved', liveAction, 'PKBarcodeFormatPDF417');
    await addVersion(
      'v3',
      'Test approved',
      { ...testAction, input: 'balance', amount: 1 },
      'PKBarcodeFormatAztec',
    );
    await addVersion('v4', 'Unapproved draft', draftAction, 'PKBarcodeFormatCode128');
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      templateId: id,
      mode: 'live',
      version: 'v2',
    });
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      templateId: id,
      mode: 'test',
      version: 'v3',
    });
    expect((await kit.registry.resolve(id)).version).toBe('v4');

    for (const { mode, name, format, action } of [
      { mode: 'live', name: 'Live approved', format: 'pdf417', action: liveAction },
      { mode: 'test', name: 'Test approved', format: 'aztec', action: testAction },
    ] as const) {
      const scanner = await kit.scanner({
        mode,
        templateIds: [id],
        settings: { acceptAllTemplates: false },
      });
      const result = await session(kit, scanner.headers);
      expect(result).toMatchObject({
        principal: 'scanner',
        state: 'ready',
        event: null,
        scanner: {
          id: scanner.id,
          orgId: kit.org.id,
          mode,
          deviceRole: 'scan',
          settings: { acceptAllTemplates: false },
        },
        formats: [format],
      });
      expect(result.templates).toEqual([
        { id, name, style: 'generic', formats: [format], actions: [action] },
      ]);
    }
  });

  it('fails an entire event or direct scope closed on every surface if one test release is missing', async () => {
    const kit = await setupScanKit();
    const approvedId = await kit.scanTemplate(
      'Approved in both modes',
      { actions: [{ id: 'entry', label: 'Admit', kind: 'check_in' }] },
      {
        passStyle: {
          barcodes: [
            {
              format: 'PKBarcodeFormatPDF417',
              message: '123456789',
              messageEncoding: 'iso-8859-1',
            },
          ],
        },
      },
    );
    const base = await kit.registry.resolve(approvedId);
    const liveOnly = kit.registry.add({
      // Sort after the first template, so a partial projection would already contain it.
      id: `${approvedId}-live-only`,
      orgId: kit.org.id,
      version: 'v1',
      manifest: {
        ...base.manifest,
        name: 'Live only',
        scan: { actions: [{ id: 'live_only', label: 'Live only', kind: 'check_in' }] },
      },
      passJson: {
        ...base.passJson,
        barcodes: [
          { format: 'PKBarcodeFormatAztec', message: '123456789', messageEncoding: 'iso-8859-1' },
        ],
      },
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, liveOnly, { registry: kit.registry });
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      templateId: liveOnly.id,
      mode: 'live',
      version: liveOnly.version,
    });

    const ids = [approvedId, liveOnly.id];
    const liveEvent = await kit.event({ mode: 'live', templateIds: ids });
    const testEvent = await kit.event({ mode: 'test', templateIds: ids });
    const expectedTemplates = [
      {
        id: approvedId,
        name: 'Approved in both modes',
        style: 'generic',
        formats: ['pdf417'],
        actions: [{ id: 'entry', label: 'Admit', kind: 'check_in' }],
      },
      {
        id: liveOnly.id,
        name: 'Live only',
        style: 'generic',
        formats: ['aztec'],
        actions: [{ id: 'live_only', label: 'Live only', kind: 'check_in' }],
      },
    ];
    const testScanners: {
      headers: Record<string, string>;
      deviceRole: 'scan' | 'customer' | 'monitor';
      eventId: string | null;
    }[] = [];

    for (const scope of ['event', 'direct'] as const) {
      for (const mode of ['live', 'test'] as const) {
        const eventId = scope === 'event' ? (mode === 'live' ? liveEvent.id : testEvent.id) : null;
        for (const deviceRole of ['scan', 'customer', 'monitor'] as const) {
          const scanner = await kit.scanner({
            mode,
            deviceRole,
            ...(eventId ? { eventId } : { templateIds: ids }),
            settings: {
              acceptAllTemplates: true,
              // Invalid scope takes precedence over even a required staff sign-in.
              staffSignIn: mode === 'test' && deviceRole === 'scan',
            },
          });
          const result = await session(kit, scanner.headers);
          if (mode === 'test') {
            expect(result).toMatchObject({
              principal: 'scanner',
              state: 'unassigned',
              workspace: null,
              event: null,
              templates: [],
              formats: [],
              scanner: {
                id: scanner.id,
                orgId: kit.org.id,
                mode: 'test',
                deviceRole,
                settings: { acceptAllTemplates: false },
              },
            });
            testScanners.push({ headers: scanner.headers, deviceRole, eventId });
          } else {
            // An event or template list is a restricted scope: it never accepts all templates.
            expect(result).toMatchObject({
              principal: 'scanner',
              state: 'ready',
              scanner: {
                id: scanner.id,
                orgId: kit.org.id,
                mode: 'live',
                deviceRole,
                settings: { acceptAllTemplates: false },
              },
            });
            expect(result.event?.id ?? null).toBe(deviceRole === 'scan' ? eventId : null);
            expect(result.templates).toEqual(deviceRole === 'scan' ? expectedTemplates : []);
          }
        }
      }
    }

    // The same configuration becomes complete once the missing mode is approved.
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      templateId: liveOnly.id,
      mode: 'test',
      version: liveOnly.version,
    });
    for (const scanner of testScanners) {
      const result = await session(kit, scanner.headers);
      expect(result).toMatchObject({
        state: scanner.deviceRole === 'scan' ? 'staff_required' : 'ready',
        scanner: { mode: 'test', settings: { acceptAllTemplates: false } },
      });
      expect(result.event?.id ?? null).toBe(scanner.deviceRole === 'scan' ? scanner.eventId : null);
      expect(result.templates).toEqual(scanner.deviceRole === 'scan' ? expectedTemplates : []);
    }
  });
});
