import { expect } from 'vitest';
import { makePass, persistTemplate } from '../../../../test/helpers/index.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { ScanAction } from '../../../passkit/types.ts';
import { type ScanSession, ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import { run } from '../../platform/db.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import type { ScanKit } from './test-kit.ts';

export async function session(kit: ScanKit, headers: Record<string, string>) {
  const response = await kit.get(headers, '/session');
  expect(response.status).toBe(200);
  return ScanSessionSchema.parse(await response.json());
}

export async function attachWorkspace(kit: ScanKit, scannerId: string, eventId: string | null) {
  const workspaceId = kit.fx.ids.id();
  const workspace = await run(
    kit.env.DB,
    `INSERT INTO scanning_sessions
      (id, org_id, mode, name, accepts, settings, time_zone, created_at, updated_at)
     SELECT ?, org_id, mode, 'Sensitive workspace',
       CASE WHEN ? IS NULL THEN NULL ELSE json_object('eventId', ?) END,
       settings, time_zone, created_at, updated_at FROM scanners WHERE id = ?`,
    [workspaceId, eventId, eventId, scannerId],
  );
  expect(workspace.changes).toBe(1);
  const device = await run(
    kit.env.DB,
    `INSERT INTO scanning_devices (scanner_id, session_id, org_id, mode, surface, effective_surface)
     SELECT id, ?, org_id, mode, 'phone', 'phone' FROM scanners WHERE id = ?`,
    [workspaceId, scannerId],
  );
  // The insert also bumps scanners.config_epoch; D1 counts trigger changes.
  expect(device.changes).toBe(2);
  return workspaceId;
}

export async function scopedRaceScanner(kit: ScanKit, templateId: string, actionId: string) {
  const event = await kit.event({ templateIds: [templateId] });
  await run(kit.env.DB, 'UPDATE scan_events SET time_zone = ? WHERE id = ?', [
    'Europe/Bucharest',
    event.id,
  ]);
  await kit.staff('manager');
  const scanner = await kit.scanner({
    eventId: event.id,
    settings: {
      acceptAllTemplates: true,
      defaultActionId: actionId,
      checkIn: { mode: 'in_out' },
      direction: 'both',
    },
  });
  await attachWorkspace(kit, scanner.id, event.id);
  return { event, scanner };
}

export function expectScopedSession(
  view: ScanSession,
  eventId: string,
  actionId: string,
  now: number,
) {
  expect(view).toMatchObject({
    state: 'ready',
    workspace: { session: { name: 'Sensitive workspace' } },
    event: { id: eventId, timeZone: 'Europe/Bucharest' },
    scanner: {
      timeZone: 'Europe/Bucharest',
      settings: { defaultActionId: actionId, checkIn: { mode: 'in_out' }, direction: 'both' },
    },
    approvals: true,
    counts: { event: expect.any(Object), asOf: now, configRev: expect.any(Number) },
  });
}

export function expectRedactedScope(view: ScanSession, kit: ScanKit, scannerId: string) {
  expect(view).toMatchObject({
    principal: 'scanner',
    state: 'unassigned',
    workspace: null,
    event: null,
    templates: [],
    formats: [],
    staff: null,
    staffList: null,
    approvals: false,
    scanner: {
      id: scannerId,
      orgId: kit.org.id,
      mode: 'live',
      timeZone: 'UTC',
      settings: { acceptAllTemplates: false, defaultActionId: null },
    },
  });
  expect(view.counts).toEqual({ today: 0, event: null, asOf: 0, configRev: 0 });
  expect(view.scanner?.settings).not.toHaveProperty('checkIn');
  expect(view.scanner?.settings).not.toHaveProperty('direction');
}

export async function legacyPass(kit: ScanKit, template: ResolvedTemplate) {
  const pass = await makePass(kit.fx, { orgId: kit.org.id, template });
  const snapshot = {
    ...template.passJson,
    serialNumber: pass.serial,
    passTypeIdentifier: kit.env.PLATFORM_PASS_TYPE_ID,
    teamIdentifier: kit.env.PLATFORM_TEAM_ID,
  };
  const updated = await run(
    kit.env.DB,
    `UPDATE pass_versions SET pass_json = ?
     WHERE pass_id = ? AND version = (SELECT version FROM passes WHERE id = ?)`,
    [JSON.stringify(snapshot), pass.id, pass.id],
  );
  expect(updated.changes).toBe(1);
  return pass;
}

export async function legacyVersions(kit: ScanKit) {
  const id = `tpl-legacy-${kit.fx.ids.token(6)}`;
  const add = async (version: string, name: string, format: string, action: ScanAction) => {
    const template = kit.registry.add({
      id,
      orgId: kit.org.id,
      version,
      manifest: { ...kit.template.manifest, name, scan: { actions: [action] } },
      passJson: {
        ...kit.template.passJson,
        barcodes: [{ format, message: '123456789', messageEncoding: 'iso-8859-1' }],
      },
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, template, { registry: kit.registry });
    return template;
  };
  const pinned = await add('v1', 'Legacy version', 'PKBarcodeFormatQR', {
    id: 'legacy_entry',
    label: 'Legacy entry',
    kind: 'check_in',
  });
  const draft = await add('v2', 'Unapproved draft', 'PKBarcodeFormatPDF417', {
    id: 'draft_entry',
    label: 'Draft entry',
    kind: 'check_in',
  });
  await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', ['v2', id]);
  return { id, pinned, draft, add };
}
