/* istanbul ignore file -- @preserve */
import { expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { scanningDeviceRow } from './repo-scanning-devices.ts';
import { scanningSessionRow } from './repo-scanning-sessions.ts';
import {
  CHECK_IN,
  created,
  expectUnassigned,
  kit,
  pair,
  request,
  sessionWithDevice,
} from './scanning-authority-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerScanningAuthorityScope() {
  it('keeps a valid event scope usable after session and device metadata edits', async () => {
    const templateId = await kit.scanTemplate('Valid scope', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId);
    const event = await kit.event({ templateIds: [templateId] });
    const { session, device, headers } = await sessionWithDevice({ eventId: event.id });
    expect(
      (await request('PATCH', `/scanning-sessions/${session.id}`, { name: 'Valid rename' })).status,
    ).toBe(200);
    expect(
      (
        await request('PATCH', `/scanning-sessions/${session.id}/devices/${device.id}`, {
          name: 'Valid device rename',
        })
      ).status,
    ).toBe(200);
    const snapshot = await request('GET', '/scan/session', undefined, headers);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      state: 'ready',
      event: { id: event.id },
      templates: [{ id: templateId }],
      scanner: { settings: { acceptAllTemplates: false } },
      workspace: { session: { accepts: { eventId: event.id } } },
    });
    const resolution = await request(
      'POST',
      '/scan/resolve',
      {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
      },
      headers,
    );
    expect(await resolution.json()).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
  });

  it('keeps a standalone monitor read-only across scanner, setup and device metadata edits', async () => {
    const source = await kit.scanner();
    const monitor = await created('/scan-setups', {
      orgId: kit.org.id,
      name: `Monitor ${kit.fx.ids.token(5)}`,
      kind: 'display',
      deviceRole: 'monitor',
      timeZone: 'UTC',
      watch: { scannerIds: [source.id], allOrg: false },
    });
    const before = await first<Record<string, unknown>>(
      kit.env.DB,
      `SELECT s.kind,s.device_role,s.mode,s.event_id,s.settings,d.session_id,d.surface,d.effective_surface,
        p.accepts,p.settings AS session_settings,p.status
       FROM scanners s JOIN scanning_devices d ON d.scanner_id=s.id
       JOIN scanning_sessions p ON p.id=d.session_id WHERE s.id=?`,
      [monitor.id],
    );
    for (const [path, name] of [
      [`/scanners/${monitor.id}`, 'Scanner rename'],
      [`/scan-setups/${monitor.id}`, 'Setup rename'],
      [`/scanning-sessions/${monitor.id}/devices/${monitor.id}`, 'Device rename'],
    ] as const) {
      const response = await request('PATCH', path, { name });
      expect(response.status).toBe(200);
      expect(
        await first(
          kit.env.DB,
          `SELECT s.kind,s.device_role,s.mode,s.event_id,s.settings,d.session_id,d.surface,d.effective_surface,
          p.accepts,p.settings AS session_settings,p.status
         FROM scanners s JOIN scanning_devices d ON d.scanner_id=s.id
         JOIN scanning_sessions p ON p.id=d.session_id WHERE s.id=?`,
          [monitor.id],
        ),
      ).toEqual(before);
    }
  });

  it('preserves malformed standalone scope across legacy metadata edits', async () => {
    const templateId = await kit.scanTemplate('Invalid scope', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId);
    const scanner = await created('/scanners', {
      orgId: kit.org.id,
      name: `Standalone ${kit.fx.ids.token(5)}`,
      kind: 'device',
      accepts: { templateIds: [templateId] },
      timeZone: 'UTC',
    });
    if (!scanner.pairing) throw new Error('Expected a scanner pairing code.');
    const headers = await pair(scanner.pairing.code);
    await run(
      kit.env.DB,
      `UPDATE scanning_sessions SET accepts=?,settings=json_set(settings,'$.acceptAllTemplates',json('true')) WHERE id=?`,
      [JSON.stringify({ templateIds: [] }), scanner.id],
    );
    const stored = await first(
      kit.env.DB,
      'SELECT accepts,settings,mode,status,time_zone FROM scanning_sessions WHERE id=?',
      [scanner.id],
    );
    for (const path of [`/scanners/${scanner.id}`, `/scan-setups/${scanner.id}`]) {
      expect((await request('PATCH', path, { name: `Rename ${kit.fx.ids.token(4)}` })).status).toBe(
        200,
      );
      expect(
        await first(
          kit.env.DB,
          'SELECT accepts,settings,mode,status,time_zone FROM scanning_sessions WHERE id=?',
          [scanner.id],
        ),
      ).toEqual(stored);
      await expectUnassigned(headers, codeOf(pass));
    }
  });

  it('does not copy unrelated scanner privileges into a session when its scope changes', async () => {
    const firstTemplate = await kit.scanTemplate('Old scope', { actions: [CHECK_IN] });
    const nextTemplate = await kit.scanTemplate('New scope', { actions: [CHECK_IN] });
    const scanner = await created('/scanners', {
      orgId: kit.org.id,
      name: `Separate policy ${kit.fx.ids.token(5)}`,
      kind: 'device',
      accepts: { templateIds: [firstTemplate] },
      timeZone: 'UTC',
    });
    await run(
      kit.env.DB,
      `UPDATE scanners SET settings=json_set(settings,'$.roleWithoutSignIn','desk','$.lookup',json('true')) WHERE id=?`,
      [scanner.id],
    );
    await run(
      kit.env.DB,
      `UPDATE scanning_sessions SET settings=json_set(settings,'$.roleWithoutSignIn','door','$.lookup',json('false')) WHERE id=?`,
      [scanner.id],
    );
    for (const path of [`/scanners/${scanner.id}`, `/scan-setups/${scanner.id}`]) {
      expect(
        (await request('PATCH', path, { accepts: { templateIds: [nextTemplate] } })).status,
      ).toBe(200);
      const row = await first<{ settings: string }>(
        kit.env.DB,
        'SELECT settings FROM scanning_sessions WHERE id=?',
        [scanner.id],
      );
      expect(JSON.parse(row?.settings ?? '{}')).toMatchObject({
        roleWithoutSignIn: 'door',
        lookup: false,
        acceptAllTemplates: false,
      });
    }
  });

  it('does not widen a stale device restriction into an all-template session', async () => {
    const templateId = await kit.scanTemplate('Conflicting scope', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId);
    const scanner = await created('/scanners', {
      orgId: kit.org.id,
      name: `Conflicting ${kit.fx.ids.token(5)}`,
      kind: 'device',
      accepts: { templateIds: [templateId] },
      timeZone: 'UTC',
    });
    if (!scanner.pairing) throw new Error('Expected a scanner pairing code.');
    const headers = await pair(scanner.pairing.code);
    await run(
      kit.env.DB,
      `UPDATE scanning_sessions SET accepts=NULL,settings=json_set(settings,'$.acceptAllTemplates',json('true')) WHERE id=?`,
      [scanner.id],
    );
    await expectUnassigned(headers, codeOf(pass));
    const response = await request(
      'PATCH',
      `/scanning-sessions/${scanner.id}/devices/${scanner.id}`,
      {
        name: 'Still restricted',
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ settings: { acceptAllTemplates: false } });
    await expectUnassigned(headers, codeOf(pass));
  });

  it('accepts only one concurrent edit of the same device or session revision', async () => {
    const templateId = await kit.scanTemplate('Concurrent edits', { actions: [CHECK_IN] });
    const { session, device } = await sessionWithDevice({ templateIds: [templateId] });
    const parent = await scanningSessionRow(kit.env.DB, kit.org.id, session.id);
    const child = await scanningDeviceRow(kit.env.DB, kit.org.id, device.id);
    if (!parent || !child) throw new Error('Missing D1 configuration fixture.');
    const sessionEdits = await Promise.all(
      ['One', 'Two'].map((name) =>
        request('PATCH', `/scanning-sessions/${session.id}`, { name, revision: parent.updated_at }),
      ),
    );
    expect(sessionEdits.map((response) => response.status).sort()).toEqual([200, 409]);
    const deviceEdits = await Promise.all(
      ['First', 'Second'].map((name) =>
        request('PATCH', `/scanning-sessions/${session.id}/devices/${device.id}`, {
          name,
          revision: child.updated_at,
        }),
      ),
    );
    expect(deviceEdits.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it('keeps an unresolved event denied through session metadata edits and every effective DTO', async () => {
    const templateId = await kit.scanTemplate('Scoped event', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId);
    const event = await kit.event({ templateIds: [templateId] });
    const { session, device, headers } = await sessionWithDevice({ eventId: event.id });
    const other = await makeOrg(kit.fx);
    const foreign = await kit.event({ orgId: other.id, templateIds: [] });
    await run(
      kit.env.DB,
      `UPDATE scanning_sessions SET accepts=?,settings=json_set(settings,'$.acceptAllTemplates',json('true')) WHERE id=?`,
      [JSON.stringify({ eventId: foreign.id }), session.id],
    );
    const stored = await first(
      kit.env.DB,
      'SELECT accepts,settings,mode,status,time_zone FROM scanning_sessions WHERE id=?',
      [session.id],
    );
    await expectUnassigned(headers, codeOf(pass));
    const renamed = await request('PATCH', `/scanning-sessions/${session.id}`, {
      name: 'Renamed event',
    });
    expect(renamed.status).toBe(200);
    expect(
      await first(
        kit.env.DB,
        'SELECT accepts,settings,mode,status,time_zone FROM scanning_sessions WHERE id=?',
        [session.id],
      ),
    ).toEqual(stored);
    const detail = await request('GET', `/scanning-sessions/${session.id}`);
    expect(await detail.json()).toMatchObject({
      accepts: null,
      settings: { acceptAllTemplates: false },
      devices: [{ id: device.id, settings: { acceptAllTemplates: false } }],
    });
    const scanner = await request('GET', `/scanners/${device.id}`);
    expect(await scanner.json()).toMatchObject({
      accepts: null,
      settings: { acceptAllTemplates: false },
    });
    await expectUnassigned(headers, codeOf(pass));
  });

  it('does not widen a session when its event loses all templates', async () => {
    const templateId = await kit.scanTemplate('Empty event', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId);
    const event = await kit.event({ templateIds: [templateId] });
    const { session, headers } = await sessionWithDevice({ eventId: event.id });
    await run(kit.env.DB, 'DELETE FROM scan_event_templates WHERE event_id=?', [event.id]);
    await run(
      kit.env.DB,
      `UPDATE scanning_sessions SET settings=json_set(settings,'$.acceptAllTemplates',json('true')) WHERE id=?`,
      [session.id],
    );
    await expectUnassigned(headers, codeOf(pass));
    const detail = await request('GET', `/scanning-sessions/${session.id}`);
    expect(await detail.json()).toMatchObject({
      accepts: null,
      settings: { acceptAllTemplates: false },
    });
  });

  it('denies an invalid pinned event even when the parent claims all templates', async () => {
    const templateId = await kit.scanTemplate('Invalid pinned event', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId);
    const event = await kit.event({ templateIds: [templateId] });
    const { session, device, headers } = await sessionWithDevice({ eventId: event.id });
    await run(
      kit.env.DB,
      `UPDATE scanning_sessions SET accepts=NULL,settings=json_set(settings,'$.acceptAllTemplates',json('true')) WHERE id=?`,
      [session.id],
    );
    await run(
      kit.env.DB,
      `UPDATE scan_events SET match_input='tier',match_values='{}' WHERE id=?`,
      [event.id],
    );
    await expectUnassigned(headers, codeOf(pass));
    const scanner = await request('GET', `/scanners/${device.id}`);
    expect(await scanner.json()).toMatchObject({
      accepts: null,
      settings: { acceptAllTemplates: false },
    });
    const detail = await request('GET', `/scanning-sessions/${session.id}`);
    expect(await detail.json()).toMatchObject({
      devices: [{ id: device.id, settings: { acceptAllTemplates: false } }],
    });
    const edited = await request('PATCH', `/scanning-sessions/${session.id}/devices/${device.id}`, {
      name: 'Invalid event device',
    });
    expect(await edited.json()).toMatchObject({ settings: { acceptAllTemplates: false } });
  });

  it('keeps a deleted configured template unassigned instead of accepting all templates', async () => {
    const templateId = await kit.scanTemplate('Deleted scope', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId);
    const { session, headers } = await sessionWithDevice({ templateIds: [templateId] });
    await run(kit.env.DB, "UPDATE templates SET status='deleted' WHERE id=?", [templateId]);
    await run(
      kit.env.DB,
      `UPDATE scanning_sessions SET settings=json_set(settings,'$.acceptAllTemplates',json('true')) WHERE id=?`,
      [session.id],
    );
    await expectUnassigned(headers, codeOf(pass));
    expect(
      (await request('PATCH', `/scanning-sessions/${session.id}`, { name: 'Still scoped' })).status,
    ).toBe(200);
    await expectUnassigned(headers, codeOf(pass));
  });
}
