import { describe, expect, it } from 'vitest';
import {
  makeOrg,
  makeScanEvent,
  makeTemplate,
  makeUser,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createScannerStore } from './auth-store.ts';
import {
  admin,
  CODE,
  type Created,
  clock,
  codeOf,
  consoleCall,
  create,
  env,
  f,
  fake,
  ORIGIN,
  orgId,
  persistApprovedTemplate,
  setupScannerFixture,
  templateId,
  userId,
} from './scanners-split-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

setupScannerFixture();

describe('create and list', () => {
  it('creates a device with a pairing code and no token', async () => {
    const { res, body } = await create();
    expect(res.status).toBe(201);
    expect(body.status).toBe('not_paired');
    expect(body.mode).toBe('live');
    expect(body.pairing?.code).toMatch(CODE);
    expect(body.pairing?.url).toBe(`${ORIGIN}/scan#pair=${body.pairing?.code}`);
    expect(body.pairing?.expiresAt).toBe(clock.now() + 10 * 60_000);
    const row = await first<{ pair_code_hash: string; token_hash: string | null }>(
      env.DB,
      'SELECT pair_code_hash, token_hash FROM scanners WHERE id = ?',
      [body.id],
    );
    expect(row?.token_hash).toBeNull();
    expect(row?.pair_code_hash).not.toContain(body.pairing?.code);
  });

  it('a terminal gets no pairing; its token is shown once and replaced by the next', async () => {
    const { body } = await create({ kind: 'terminal', name: 'Till 1' });
    expect(body.pairing).toBeNull();
    const first1 = (await (await consoleCall('POST', `/${body.id}/token`)).json()) as {
      token: string;
      expiresAt: number;
    };
    expect(first1.token).toMatch(/^wls_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(first1.expiresAt).toBe(clock.now() + 365 * 86_400_000);
    const second = (await (await consoleCall('POST', `/${body.id}/token`)).json()) as {
      token: string;
    };
    const store = createScannerStore(env, clock);
    expect(await store.resolve(first1.token, 'bearer')).toBeNull();
    expect((await store.resolve(second.token, 'bearer'))?.scannerId).toBe(body.id);
    const get = (await (await consoleCall('GET', `/${body.id}`)).json()) as Created;
    expect(JSON.stringify(get)).not.toContain(second.token);
  });

  it('a device has no token route', async () => {
    const { body } = await create();
    const res = await consoleCall('POST', `/${body.id}/token`);
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('SCANNER_NOT_TERMINAL');
  });

  it('lists by mode and org, newest first, and pages', async () => {
    const other = await makeOrg(f);
    await grantScanMembership(f, other.id, userId);
    const a = await create({ name: 'A' });
    const b = await create({ name: 'B' });
    await create({ name: 'T', accepts: { templateIds: [templateId] } }, admin('test'));
    const o = makeTemplate({ id: f.ids.id(), orgId: other.id });
    await persistApprovedTemplate(o, ['live']);
    await create({ orgId: other.id, name: 'Other', accepts: { templateIds: [o.resolved.id] } });
    const page = async (query: string, headers = admin()) =>
      (await (await consoleCall('GET', query, undefined, headers)).json()) as {
        items: { id: string; name: string }[];
        nextCursor: string | null;
      };
    const live = await page(`?orgId=${orgId}`);
    expect(live.items.map((s) => s.name)).toEqual(['B', 'A']);
    expect((await page(`?orgId=${orgId}`, admin('test'))).items.map((s) => s.name)).toEqual(['T']);
    const first1 = await page(`?orgId=${orgId}&limit=1`);
    expect(first1.items.map((s) => s.id)).toEqual([b.body.id]);
    expect(first1.nextCursor).toBe(b.body.id);
    expect((await page(`?orgId=${orgId}&limit=1&cursor=${first1.nextCursor}`)).items[0]?.id).toBe(
      a.body.id,
    );
    expect((await page(`?orgId=${orgId}&status=paired`)).items).toEqual([]);
    expect((await page(`?orgId=${orgId}&q=b`)).items.map((s) => s.name)).toEqual(['B']);
  });

  it("another org's template or event is a 404; another mode's event is 422 SCAN_MODE_MISMATCH", async () => {
    const other = await makeOrg(f);
    const o = makeTemplate({ id: f.ids.id(), orgId: other.id });
    await persistTemplate(f, o.resolved, { registry: o.registry });
    expect((await create({ accepts: { templateIds: [o.resolved.id] } })).res.status).toBe(404);
    const foreign = await makeScanEvent(f, { orgId: other.id, templateIds: [o.resolved.id] });
    expect((await create({ accepts: { eventId: foreign.id } })).res.status).toBe(404);
    const testEvent = await makeScanEvent(f, { orgId, mode: 'test', templateIds: [templateId] });
    const { res } = await create({ accepts: { eventId: testEvent.id } });
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('SCAN_MODE_MISMATCH');
    const { res: ok, body } = await create({
      accepts: { eventId: (await makeScanEvent(f, { orgId, templateIds: [templateId] })).id },
    });
    expect(ok.status).toBe(201);
    expect(body.id).toBeTruthy();
  });

  it.each(['draft', null] as const)(
    'accepts a scoped release in both scanner modes with legacy version %s',
    async (version) => {
      if (version !== null) {
        const draft = makeTemplate({ id: templateId, orgId, version });
        await persistTemplate(f, draft.resolved, { registry: draft.registry });
      }
      await run(env.DB, 'UPDATE templates SET active_version=? WHERE id=?', [version, templateId]);
      expect((await create()).res.status).toBe(201);
      expect((await create({}, admin('test'))).res.status).toBe(201);
      const event = await makeScanEvent(f, { orgId, templateIds: [templateId] });
      expect((await create({ accepts: { eventId: event.id } })).res.status).toBe(201);
    },
  );

  it('rejects missing and wrong-mode releases in template and event assignments', async () => {
    const liveOnly = makeTemplate({ id: f.ids.id(), orgId });
    const missing = makeTemplate({ id: f.ids.id(), orgId });
    await persistApprovedTemplate(liveOnly, ['live']);
    await persistTemplate(f, missing.resolved, { registry: missing.registry });
    for (const id of [liveOnly.resolved.id, missing.resolved.id]) {
      const result = await create({ accepts: { templateIds: [id] } }, admin('test'));
      expect(result.res.status).toBe(404);
      expect(await codeOf(result.res)).toBe('TEMPLATE_NOT_FOUND');
      const event = await makeScanEvent(f, {
        orgId,
        mode: 'test',
        templateIds: [templateId, id],
      });
      const eventResult = await create({ accepts: { eventId: event.id } }, admin('test'));
      expect(eventResult.res.status).toBe(404);
      expect(await codeOf(eventResult.res)).toBe('EVENT_NOT_FOUND');
    }
  });

  it('validates the separate check-in event on creation and updates', async () => {
    const other = await makeOrg(f);
    const foreign = await makeScanEvent(f, { orgId: other.id, templateIds: [templateId] });
    const wrongMode = await makeScanEvent(f, { orgId, mode: 'test', templateIds: [templateId] });
    const missing = makeTemplate({ id: f.ids.id(), orgId });
    await persistTemplate(f, missing.resolved, { registry: missing.registry });
    const unapproved = await makeScanEvent(f, { orgId, templateIds: [missing.resolved.id] });
    const valid = await makeScanEvent(f, { orgId, templateIds: [templateId] });
    const { body } = await create();
    const before = await first(env.DB, 'SELECT settings FROM scanners WHERE id=?', [body.id]);

    for (const [eventId, status, code] of [
      [foreign.id, 404, 'EVENT_NOT_FOUND'],
      [wrongMode.id, 422, 'SCAN_MODE_MISMATCH'],
      [unapproved.id, 404, 'EVENT_NOT_FOUND'],
    ] as const) {
      const settings = { checkIn: { eventId } };
      const creation = await create({ settings });
      expect(creation.res.status).toBe(status);
      expect(await codeOf(creation.res)).toBe(code);
      const update = await consoleCall('PATCH', `/${body.id}`, { settings });
      expect(update.status).toBe(status);
      expect(await codeOf(update)).toBe(code);
      expect(await first(env.DB, 'SELECT settings FROM scanners WHERE id=?', [body.id])).toEqual(
        before,
      );
    }
    expect((await create({ settings: { checkIn: { eventId: valid.id } } })).res.status).toBe(201);
    expect(
      (
        await consoleCall('PATCH', `/${body.id}`, {
          settings: { checkIn: { eventId: valid.id } },
        })
      ).status,
    ).toBe(200);
  });

  it('patch with another org template is a 404; a duplicate name is a 409', async () => {
    const other = await makeOrg(f);
    const o = makeTemplate({ id: f.ids.id(), orgId: other.id });
    await persistTemplate(f, o.resolved, { registry: o.registry });
    const { body } = await create({ name: 'Main' });
    expect(
      (await consoleCall('PATCH', `/${body.id}`, { accepts: { templateIds: [o.resolved.id] } }))
        .status,
    ).toBe(404);
    expect((await create({ name: 'main' })).res.status).toBe(409);
    const renamed = await consoleCall('PATCH', `/${body.id}`, {
      name: 'Back door',
      settings: { flow: 'choose' },
    });
    expect(renamed.status).toBe(200);
    const dto = (await renamed.json()) as {
      name: string;
      settings: { flow: string; lookup: boolean };
    };
    expect(dto.name).toBe('Back door');
    expect(dto.settings).toMatchObject({ flow: 'choose', lookup: true });
  });

  it('requires tenant access', async () => {
    expect((await consoleCall('GET', `?orgId=${orgId}`, undefined, fake.user())).status).toBe(403);
    expect((await consoleCall('GET', '', undefined, {})).status).toBe(401);
  });

  it('limits scanner reads and mutations to the tenant capabilities of the session', async () => {
    const { body: deviceScanner } = await create();
    const { body: terminal } = await create({ kind: 'terminal' });
    const sql = `SELECT id,name,mode,revoked_at,pair_code_hash,token_hash FROM scanners
      WHERE id IN (?,?) ORDER BY id`;
    const ids = [deviceScanner.id, terminal.id];
    const before = await all(env.DB, sql, ids);
    const reader = await makeUser(f);
    const operator = await makeUser(f);
    const outsider = await makeUser(f);
    await grantScanMembership(f, orgId, reader.id, ['read_only']);
    await grantScanMembership(f, orgId, operator.id, ['pass_operator']);
    const readHeaders = fake.session({ userId: reader.id, roles: ['user'] });
    const operatorHeaders = fake.session({ userId: operator.id, roles: ['admin', 'user'] });
    const outsiderHeaders = fake.session({ userId: outsider.id, roles: ['admin', 'user'] });

    for (const headers of [readHeaders, operatorHeaders]) {
      expect((await consoleCall('GET', `?orgId=${orgId}`, undefined, headers)).status).toBe(200);
      expect((await consoleCall('GET', `/${deviceScanner.id}`, undefined, headers)).status).toBe(
        200,
      );
      expect(
        (await consoleCall('GET', `/${deviceScanner.id}/pairing`, undefined, headers)).status,
      ).toBe(200);
    }
    for (const path of [`?orgId=${orgId}`, `/${deviceScanner.id}`, `/${deviceScanner.id}/pairing`])
      expect((await consoleCall('GET', path, undefined, outsiderHeaders)).status).toBe(403);

    const writes: [string, string, unknown?][] = [
      [
        'POST',
        '',
        {
          orgId,
          name: 'Denied',
          kind: 'terminal',
          timeZone: 'UTC',
          accepts: { templateIds: [templateId] },
        },
      ],
      ['PATCH', `/${deviceScanner.id}`, { name: 'Denied' }],
      ['POST', `/${deviceScanner.id}/pairing`],
      ['POST', `/${deviceScanner.id}/pair-here`],
      ['POST', `/${terminal.id}/token`],
      ['POST', `/${deviceScanner.id}/revoke`],
      ['POST', `/${deviceScanner.id}/mode`, { mode: 'test' }],
      ['POST', `/${deviceScanner.id}/sample-pass`],
    ];
    for (const headers of [readHeaders, operatorHeaders, outsiderHeaders])
      for (const [method, path, body] of writes)
        expect((await consoleCall(method, path, body, headers)).status, path).toBe(403);

    expect(await all(env.DB, sql, ids)).toEqual(before);
    expect(await first(env.DB, "SELECT id FROM scanners WHERE name='Denied'")).toBeNull();
  });

  it('lets an organization manager administer scanners without platform-admin status', async () => {
    const manager = await makeUser(f);
    await grantScanMembership(f, orgId, manager.id, ['org_admin']);
    const headers = fake.session({ userId: manager.id, roles: ['user'] });
    const { res, body } = await create({ kind: 'terminal' }, headers);
    expect(res.status).toBe(201);
    expect(
      (await consoleCall('PATCH', `/${body.id}`, { name: 'Managed till' }, headers)).status,
    ).toBe(200);
    expect((await consoleCall('POST', `/${body.id}/mode`, { mode: 'live' }, headers)).status).toBe(
      200,
    );
    const issued = await consoleCall('POST', `/${body.id}/token`, undefined, headers);
    expect(issued.status).toBe(200);
    expect(await issued.json()).toMatchObject({ token: expect.any(String) });
    expect((await consoleCall('POST', `/${body.id}/revoke`, undefined, headers)).status).toBe(200);
  });
});
