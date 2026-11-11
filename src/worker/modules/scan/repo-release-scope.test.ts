import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, persistTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { type ScanActor, scannerActor, withRole } from './actor.ts';
import { actorAuthorityCurrent } from './repo-actor-authority.ts';
import { getScanner } from './repo-device.ts';
import { templateManifests } from './repo-event-templates.ts';
import { getConsoleEvent } from './repo-events.ts';
import { countOrgTemplates, readScannerScope, readValidEventScope } from './repo-scope.ts';
import { captureTemplateStamps } from './repo-scope-releases.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import {
  approveScanReleases,
  makeLegacyScanPass,
  proofedScanActor,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
let kit: ScanKit;

beforeEach(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

async function actorFor(scannerId: string) {
  const scanner = await getScanner(kit.env.DB, scannerId);
  if (!scanner) throw new Error('Missing scanner.');
  const scope = await readScannerScope(kit.env.DB, scanner, null);
  const actor = scannerActor(kit.ctx, scanner, scanner.mode, 'cookie', scope);
  await bindScanningSession(kit.ctx, actor);
  return proofedScanActor(kit.ctx, withRole(actor, null));
}

function current(actor: ScanActor, templateId: string) {
  return actorAuthorityCurrent(kit.env.DB, {
    actor,
    now: kit.clock.now(),
    event: actor.event,
    templateId,
    adminEventTemplates: false,
  });
}

describe('approved scanner release scopes', () => {
  it.each(['unreleased', 'wrong-mode', 'cross-org'] as const)(
    'denies a partially configured %s scanner and event rather than widening them',
    async (problem) => {
      const approved = await kit.scanTemplate('Approved', { actions: [CHECK_IN] });
      const other = problem === 'cross-org' ? await makeOrg(kit.fx) : null;
      const invalid = await kit.scanTemplate(
        'Invalid',
        { actions: [CHECK_IN] },
        {
          ...(other ? { orgId: other.id } : {}),
          ...(problem === 'unreleased' ? { releaseModes: [] } : {}),
          ...(problem === 'wrong-mode' ? { releaseModes: ['test'] } : {}),
        },
      );
      const event = await kit.event({ templateIds: [approved, invalid] });
      const scanner = await kit.scanner({
        templateIds: [approved, invalid],
        settings: { acceptAllTemplates: true },
      });
      const stored = await getScanner(kit.env.DB, scanner.id);
      if (!stored) throw new Error('Missing scanner.');
      expect(await readScannerScope(kit.env.DB, stored, null)).toMatchObject({
        valid: false,
        restricted: true,
        templateIds: [],
      });
      expect(await readValidEventScope(kit.env.DB, kit.org.id, 'live', event.id)).toBeNull();
      expect(await countOrgTemplates(kit.env.DB, kit.org.id, 'live', [approved, invalid])).toBe(1);
      expect(await current(await actorFor(scanner.id), approved)).toBe(false);
    },
  );

  it('uses approved mode-specific heads and manifests instead of the legacy active version', async () => {
    const templateId = await kit.scanTemplate(
      'Approved policy',
      { actions: [CHECK_IN] },
      { releaseModes: ['live'] },
    );
    const original = await kit.registry.resolve(templateId);
    const draft = kit.registry.add({
      id: templateId,
      orgId: original.orgId,
      version: 'unapproved-draft',
      manifest: { ...original.manifest, name: 'Unapproved policy' },
      passJson: original.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, draft, { registry: kit.registry });
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    for (const legacy of ['unapproved-draft', null]) {
      await run(kit.env.DB, 'UPDATE templates SET active_version=? WHERE id=?', [
        legacy,
        templateId,
      ]);
      expect(await countOrgTemplates(kit.env.DB, kit.org.id, 'live', [templateId])).toBe(1);
      expect(await countOrgTemplates(kit.env.DB, kit.org.id, 'test', [templateId])).toBe(0);
      expect(
        (await readValidEventScope(kit.env.DB, kit.org.id, 'live', event.id))?.templateIds,
      ).toEqual([templateId]);
      const stamps = await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [templateId]);
      if (!stamps) throw new Error('Missing approved template snapshot.');
      expect(
        (await templateManifests(kit.env.DB, kit.org.id, stamps)).map(
          (t) => JSON.parse(t.manifest).name,
        ),
      ).toEqual(['Approved policy']);
      const actor = await actorFor(scanner.id);
      expect(actor.invalidScannerScope).toBe(false);
      expect(await current(actor, templateId)).toBe(true);
    }
  });

  it('accepts a global uploaded template only for an organization with its own approved head', async () => {
    const other = await makeOrg(kit.fx);
    const template = kit.registry.add({
      id: `${kit.fx.ids.id()},global`,
      orgId: null,
      manifest: { ...kit.template.manifest, scan: { actions: [CHECK_IN] } },
      passJson: kit.template.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, template, { registry: kit.registry });
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      templateId: template.id,
      version: template.version,
      mode: 'live',
    });
    const event = await kit.event({ templateIds: [template.id] });
    const foreign = await kit.event({ orgId: other.id, templateIds: [template.id] });
    const scanner = await kit.scanner({ templateIds: [template.id] });
    expect(await countOrgTemplates(kit.env.DB, kit.org.id, 'live', [template.id])).toBe(1);
    expect(await countOrgTemplates(kit.env.DB, kit.org.id, 'test', [template.id])).toBe(0);
    expect(await countOrgTemplates(kit.env.DB, other.id, 'live', [template.id])).toBe(0);
    expect(
      (await readValidEventScope(kit.env.DB, kit.org.id, 'live', event.id))?.templateIds,
    ).toEqual([template.id]);
    expect((await getConsoleEvent(kit.env.DB, event.id))?.templateIds).toEqual([template.id]);
    expect(await readValidEventScope(kit.env.DB, other.id, 'live', foreign.id)).toBeNull();
    expect(await current(await actorFor(scanner.id), template.id)).toBe(true);
    const stamps = await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [template.id]);
    if (!stamps) throw new Error('Missing approved global template snapshot.');
    expect(await templateManifests(kit.env.DB, kit.org.id, stamps)).toHaveLength(1);
    expect(await captureTemplateStamps(kit.env.DB, other.id, 'live', [template.id])).toBeNull();
  });

  it('keeps configured templates restricted if the scanner mode changes during scope resolution', async () => {
    const templateId = await kit.scanTemplate('Mode race', { actions: [CHECK_IN] });
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { acceptAllTemplates: true },
    });
    const observed = await getScanner(kit.env.DB, scanner.id);
    if (!observed) throw new Error('Missing scanner.');
    await run(kit.env.DB, "UPDATE scanners SET mode='test' WHERE id=?", [scanner.id]);
    expect(await readScannerScope(kit.env.DB, observed, null)).toMatchObject({
      valid: false,
      restricted: true,
      templateIds: [],
    });
  });

  it('retains a restricted legacy scope only while a same-tenant, same-mode pinned pass exists', async () => {
    const templateId = await kit.scanTemplate(
      'Pinned legacy',
      { actions: [CHECK_IN] },
      { releaseModes: [] },
    );
    const legacy = await makeLegacyScanPass(kit.fx, {
      orgId: kit.org.id,
      template: await kit.registry.resolve(templateId),
    });
    await run(kit.env.DB, 'UPDATE templates SET active_version=NULL WHERE id=?', [templateId]);
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { acceptAllTemplates: true },
    });
    const eventScanner = await kit.scanner({
      eventId: event.id,
      settings: { acceptAllTemplates: true },
    });
    const actor = await actorFor(scanner.id);
    const eventActor = await actorFor(eventScanner.id);
    expect(actor).toMatchObject({
      templateIds: [templateId],
      settings: { acceptAllTemplates: false },
    });
    expect(eventActor).toMatchObject({
      templateIds: [templateId],
      settings: { acceptAllTemplates: false },
    });
    expect(
      (await readValidEventScope(kit.env.DB, kit.org.id, 'live', event.id))?.templateIds,
    ).toEqual([templateId]);
    expect(await countOrgTemplates(kit.env.DB, kit.org.id, 'test', [templateId])).toBe(0);
    expect(await current(actor, templateId)).toBe(true);
    expect(await current(eventActor, templateId)).toBe(true);
    await run(kit.env.DB, 'UPDATE passes SET deleted_at=? WHERE id=?', [
      kit.clock.now(),
      legacy.id,
    ]);
    expect(await readValidEventScope(kit.env.DB, kit.org.id, 'live', event.id)).toBeNull();
    expect(await current(actor, templateId)).toBe(false);
    expect(await current(eventActor, templateId)).toBe(false);
  });

  it.each([
    'newer-null',
    'malformed',
    'serial',
    'pass-type',
    'team',
    'void-invalid',
    'void-null',
    'expiry-invalid',
    'expiry-null',
  ] as const)('does not keep legacy scope assigned after a %s Wallet snapshot', async (change) => {
    const templateId = await kit.scanTemplate(
      'Legacy wallet',
      { actions: [CHECK_IN] },
      { releaseModes: [] },
    );
    const pass = await makeLegacyScanPass(kit.fx, {
      orgId: kit.org.id,
      template: await kit.registry.resolve(templateId),
    });
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { acceptAllTemplates: true },
    });
    const actor = await actorFor(scanner.id);
    expect(await current(actor, templateId)).toBe(true);
    if (change === 'newer-null') {
      await run(
        kit.env.DB,
        `INSERT INTO pass_versions
          (pass_id,version,template_version,personalization,pass_json,cause,created_at)
          SELECT pass_id,2,template_version,personalization,NULL,cause,created_at
          FROM pass_versions WHERE pass_id=? AND version=1`,
        [pass.id],
      );
      await run(kit.env.DB, 'UPDATE passes SET version=2 WHERE id=?', [pass.id]);
    } else if (change === 'malformed') {
      await run(kit.env.DB, "UPDATE pass_versions SET pass_json='{' WHERE pass_id=?", [pass.id]);
    } else if (change.startsWith('void-') || change.startsWith('expiry-')) {
      const field = change.startsWith('void-') ? 'voided' : 'expirationDate';
      const value = change.endsWith('-null') ? null : 'invalid';
      await run(
        kit.env.DB,
        'UPDATE pass_versions SET pass_json=json_set(pass_json,?,json(?)) WHERE pass_id=?',
        [`$.${field}`, JSON.stringify(value), pass.id],
      );
    } else {
      const field =
        change === 'serial'
          ? 'serialNumber'
          : change === 'pass-type'
            ? 'passTypeIdentifier'
            : 'teamIdentifier';
      await run(
        kit.env.DB,
        'UPDATE pass_versions SET pass_json=json_set(pass_json,?,?) WHERE pass_id=?',
        [`$.${field}`, 'wrong', pass.id],
      );
    }
    expect(await current(actor, templateId)).toBe(false);
    expect(await actorFor(scanner.id)).toMatchObject({
      invalidScannerScope: true,
      templateIds: [],
      settings: { acceptAllTemplates: false },
    });
    expect(await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [templateId])).toBeNull();
  });

  it('keeps expired and voided legacy passes scoped for their normal scanner refusal', async () => {
    const templateId = await kit.scanTemplate(
      'Legacy refusal',
      { actions: [CHECK_IN] },
      { releaseModes: [] },
    );
    const pass = await makeLegacyScanPass(kit.fx, {
      orgId: kit.org.id,
      template: await kit.registry.resolve(templateId),
    });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    for (const [path, value] of [
      ['$.expirationDate', '2000-01-01T00:00:00Z'],
      ['$.voided', true],
    ] as const) {
      await run(
        kit.env.DB,
        'UPDATE pass_versions SET pass_json=json_set(pass_json,?,json(?)) WHERE pass_id=?',
        [path, JSON.stringify(value), pass.id],
      );
      expect(await current(await actorFor(scanner.id), templateId)).toBe(true);
    }
  });

  it('does not revive legacy scope after an existing release becomes ineligible', async () => {
    const templateId = await kit.scanTemplate(
      'Ineligible history',
      { actions: [CHECK_IN] },
      { releaseModes: ['live'] },
    );
    await makeLegacyScanPass(kit.fx, {
      orgId: kit.org.id,
      template: await kit.registry.resolve(templateId),
    });
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({
      eventId: event.id,
      settings: { acceptAllTemplates: true },
    });
    const actor = await actorFor(scanner.id);
    expect(await current(actor, templateId)).toBe(true);
    await run(kit.env.DB, "UPDATE templates SET status='archived' WHERE id=?", [templateId]);
    expect(await readValidEventScope(kit.env.DB, kit.org.id, 'live', event.id)).toBeNull();
    expect(await current(actor, templateId)).toBe(false);
    const refreshed = await actorFor(scanner.id);
    expect(refreshed).toMatchObject({
      invalidScannerScope: true,
      templateIds: [],
      settings: { acceptAllTemplates: false },
    });
  });

  it('projects all distinct eligible pinned legacy versions, but never across modes or release history', async () => {
    const templateId = await kit.scanTemplate(
      'Pinned versions',
      { actions: [CHECK_IN] },
      { releaseModes: [] },
    );
    const original = await kit.registry.resolve(templateId);
    const next = kit.registry.add({
      id: templateId,
      orgId: original.orgId,
      version: 'v2',
      manifest: original.manifest,
      passJson: original.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, next, { registry: kit.registry });
    const first = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template: original });
    const second = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template: original });
    await run(kit.env.DB, "UPDATE passes SET template_version='v2' WHERE id=?", [second.id]);
    expect(
      (await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [templateId]))?.legacy[0]
        ?.versions,
    ).toEqual([original.version, 'v2'].sort());
    expect(await captureTemplateStamps(kit.env.DB, kit.org.id, 'test', [templateId])).toBeNull();
    const other = await makeOrg(kit.fx);
    expect(await captureTemplateStamps(kit.env.DB, other.id, 'live', [templateId])).toBeNull();
    await run(kit.env.DB, 'UPDATE passes SET deleted_at=? WHERE id=?', [kit.clock.now(), first.id]);
    expect(
      (await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [templateId]))?.legacy[0]
        ?.versions,
    ).toEqual(['v2']);
    await approveScanReleases(kit, templateId, { modes: ['live'], version: original.version });
    expect(
      (await captureTemplateStamps(kit.env.DB, kit.org.id, 'live', [templateId]))?.legacy,
    ).toEqual([]);
  });

  it.each(['scanner', 'event', 'session'] as const)(
    'rejects an unresolved %s template added after the actor was evaluated',
    async (kind) => {
      const approved = await kit.scanTemplate('Previously valid', { actions: [CHECK_IN] });
      const missing = await kit.scanTemplate(
        'Unreleased addition',
        { actions: [CHECK_IN] },
        { releaseModes: [] },
      );
      const event = kind === 'event' ? await kit.event({ templateIds: [approved] }) : null;
      const scanner = await kit.scanner(
        event ? { eventId: event.id } : { templateIds: [approved] },
      );
      let sessionId: string | null = null;
      if (kind === 'session') {
        sessionId = kit.fx.ids.id();
        await run(
          kit.env.DB,
          `INSERT INTO scanning_sessions
          (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
          SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at
          FROM scanners WHERE id=?`,
          [sessionId, JSON.stringify({ templateIds: [approved] }), scanner.id],
        );
        await run(
          kit.env.DB,
          `INSERT INTO scanning_devices
          (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
          SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
          [sessionId, scanner.id],
        );
      }
      const actor = await actorFor(scanner.id);
      expect(await current(actor, approved)).toBe(true);
      if (event) {
        await run(
          kit.env.DB,
          'INSERT INTO scan_event_templates(event_id,template_id) VALUES (?,?)',
          [event.id, missing],
        );
      } else if (sessionId) {
        await run(kit.env.DB, 'UPDATE scanning_sessions SET accepts=? WHERE id=?', [
          JSON.stringify({ templateIds: [approved, missing] }),
          sessionId,
        ]);
      } else {
        await run(
          kit.env.DB,
          'INSERT INTO scanner_templates(scanner_id,template_id) VALUES (?,?)',
          [scanner.id, missing],
        );
      }
      expect(await current(actor, approved)).toBe(false);
    },
  );
});
