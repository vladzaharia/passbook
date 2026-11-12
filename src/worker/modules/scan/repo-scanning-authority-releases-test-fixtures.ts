/* istanbul ignore file -- @preserve */
import { expect, it } from 'vitest';
import { makePass } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import {
  admin,
  CHECK_IN,
  expectUnassigned,
  kit,
  pair,
  request,
  sessionWithDevice,
} from './scanning-authority-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerScanningAuthorityReleases() {
  it.each(['templates', 'event'] as const)(
    'keeps a %s scope assigned for a same-mode legacy pass with no release head',
    async (kind) => {
      const templateId = await kit.scanTemplate(
        'Legacy scope',
        { actions: [CHECK_IN] },
        {
          releaseModes: [],
        },
      );
      const template = await kit.registry.resolve(templateId);
      const pass = await makePass(kit.fx, { orgId: kit.org.id, template });
      await run(kit.env.DB, 'UPDATE pass_versions SET pass_json=? WHERE pass_id=?', [
        JSON.stringify({
          ...template.passJson,
          serialNumber: pass.serial,
          passTypeIdentifier: kit.env.PLATFORM_PASS_TYPE_ID,
          teamIdentifier: kit.env.PLATFORM_TEAM_ID,
        }),
        pass.id,
      ]);
      await run(kit.env.DB, 'UPDATE templates SET active_version=NULL WHERE id=?', [templateId]);
      const event = kind === 'event' ? await kit.event({ templateIds: [templateId] }) : null;
      const accepts = event ? { eventId: event.id } : { templateIds: [templateId] };
      const { session, headers } = await sessionWithDevice(accepts);
      const snapshot = await request('GET', '/scan/session', undefined, headers);
      expect(snapshot.status).toBe(200);
      expect(await snapshot.json()).toMatchObject({
        state: 'ready',
        scanner: { mode: 'live', settings: { acceptAllTemplates: false } },
        workspace: { session: { accepts, settings: { acceptAllTemplates: false } } },
      });
      const detail = await request('GET', `/scanning-sessions/${session.id}`);
      expect(await detail.json()).toMatchObject({
        accepts,
        settings: { acceptAllTemplates: false },
      });
      const resolution = await request(
        'POST',
        '/scan/resolve',
        {
          idempotencyKey: key(),
          input: { passId: pass.id, method: 'manual' },
          clientTs: kit.clock.now(),
        },
        headers,
      );
      expect(await resolution.json()).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
      const wrongMode = await request(
        'POST',
        '/scanning-sessions',
        {
          orgId: kit.org.id,
          name: `Wrong-mode scope ${kit.fx.ids.token(5)}`,
          timeZone: 'UTC',
          accepts: { templateIds: [templateId] },
        },
        { ...admin, 'x-passbook-mode': 'test' },
      );
      expect(wrongMode.status).toBe(404);
    },
  );

  it('keeps a released template assigned when its legacy active version is null', async () => {
    const templateId = await kit.scanTemplate('Missing legacy version', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId);
    const { session, headers } = await sessionWithDevice({ templateIds: [templateId] });
    await run(kit.env.DB, 'UPDATE templates SET active_version=NULL WHERE id=?', [templateId]);
    await run(
      kit.env.DB,
      `UPDATE scanning_sessions SET settings=json_set(settings,'$.acceptAllTemplates',json('true')) WHERE id=?`,
      [session.id],
    );
    const snapshot = await request('GET', '/scan/session', undefined, headers);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      state: 'ready',
      templates: [{ id: templateId }],
      scanner: { settings: { acceptAllTemplates: false } },
      workspace: { session: { accepts: { templateIds: [templateId] } } },
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
    const detail = await request('GET', `/scanning-sessions/${session.id}`);
    expect(await detail.json()).toMatchObject({
      accepts: { templateIds: [templateId] },
      settings: { acceptAllTemplates: false },
    });
  });

  it('resolves a Test session from its Test release rather than the Live or legacy version', async () => {
    const templateId = await kit.scanTemplate(
      'Test-only scope',
      { actions: [CHECK_IN] },
      {
        releaseModes: ['test'],
      },
    );
    const pass = await kit.scanPass(templateId, {}, { mode: 'test' });
    await run(kit.env.DB, 'UPDATE templates SET active_version=NULL WHERE id=?', [templateId]);
    const input = {
      orgId: kit.org.id,
      name: `Test session ${kit.fx.ids.token(5)}`,
      timeZone: 'UTC',
      accepts: { templateIds: [templateId] },
    };
    expect((await request('POST', '/scanning-sessions', input)).status).toBe(404);
    const testHeaders = { ...admin, 'x-passbook-mode': 'test' };
    const made = await request('POST', '/scanning-sessions', input, testHeaders);
    expect(made.status).toBe(201);
    const session = (await made.json()) as { id: string };
    const added = await request(
      'POST',
      `/scanning-sessions/${session.id}/devices`,
      {
        name: `Test device ${kit.fx.ids.token(5)}`,
        surface: 'phone',
      },
      testHeaders,
    );
    expect(added.status).toBe(201);
    const device = (await added.json()) as { pairing: { code: string } };
    const headers = await pair(device.pairing.code);
    const snapshot = await request('GET', '/scan/session', undefined, headers);
    expect(await snapshot.json()).toMatchObject({
      state: 'ready',
      templates: [{ id: templateId }],
      scanner: { mode: 'test', settings: { acceptAllTemplates: false } },
      workspace: { session: { mode: 'test', accepts: { templateIds: [templateId] } } },
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

  it('redacts a parent scope when a legacy device has an oversized template list', async () => {
    const templateId = await kit.scanTemplate('Oversized device scope', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId);
    const { session, device, headers } = await sessionWithDevice({ templateIds: [templateId] });
    for (let i = 0; i < 20; i++) {
      const extra = await kit.scanTemplate(`Extra scope ${i}`, { actions: [CHECK_IN] });
      await run(kit.env.DB, 'INSERT INTO scanner_templates(scanner_id,template_id) VALUES(?,?)', [
        device.id,
        extra,
      ]);
    }
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
  });
}
