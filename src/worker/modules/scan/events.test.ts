import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeScanEvent,
  makeScanner,
  makeTemplate,
  makeUser,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createScannerStore } from './auth-store.ts';

const ORIGIN = 'https://wallet.test';
const HOUR = 3_600_000;

const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

let env: AppEnv;
let f: Fixtures;
let clock: ManualClock;
let fake: ReturnType<typeof fakeAuth>;
let app: ReturnType<typeof createApp>;
let orgId: string;
let userId: string;
let templateId: string;

beforeEach(async () => {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  env = await makeEnv();
  f = fixtures(env, clock);
  fake = fakeAuth(ORIGIN);
  app = createApp({ stores: { ...fake.stores, scanners: createScannerStore(env, clock) }, clock });
  await run(env.DB, 'DELETE FROM audit_log');
  userId = (await makeUser(f)).id;
  orgId = (await makeOrg(f)).id;
  templateId = await template(orgId);
});

async function template(org: string, manifest: Record<string, unknown> = {}): Promise<string> {
  const t = makeTemplate({ id: f.ids.id(), orgId: org });
  Object.assign(t.resolved.manifest, manifest);
  await persistTemplate(f, t.resolved);
  return t.resolved.id;
}
const admin = (mode?: 'test') =>
  fake.session({ userId, roles: ['admin', 'user'], ...(mode ? { mode } : {}) });
const call = (method: string, path: string, body?: unknown, headers = admin()) =>
  app.request(
    `${ORIGIN}/api/v1/scan-events${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    },
    env,
  );
interface Ev {
  id: string;
  status: string;
  arrived: number;
  expected: number;
  scanners: number;
  note: string | null;
  templateIds: string[];
  match: { input: string; values: string[] } | null;
  code?: string;
}
async function create(over: Record<string, unknown> = {}, headers = admin()) {
  clock.advance(1);
  const res = await call(
    'POST',
    '',
    {
      orgId,
      name: `Event ${f.ids.token(3)}`,
      templateIds: [templateId],
      opensAt: clock.now() - HOUR,
      closesAt: clock.now() + HOUR,
      timeZone: 'Europe/Berlin',
      ...over,
    },
    headers,
  );
  return { res, body: (await res.clone().json()) as Ev };
}
const auditActions = async () =>
  (await all<{ action: string }>(env.DB, 'SELECT action FROM audit_log ORDER BY id')).map(
    (r) => r.action,
  );

describe('events', () => {
  it('creates, reads and edits an event with a status', async () => {
    const { res, body } = await create({
      name: 'Gala',
      capacity: 200,
      reentry: true,
      note: 'Doors at 7.',
    });
    expect(res.status).toBe(201);
    expect(body).toMatchObject({
      status: 'live',
      templateIds: [templateId],
      arrived: 0,
      expected: 0,
      scanners: 0,
      note: 'Doors at 7.',
    });
    const got = (await (await call('GET', `/${body.id}`)).json()) as Ev;
    expect(got.id).toBe(body.id);
    const edited = await call('PATCH', `/${body.id}`, {
      name: 'Gala 2',
      opensAt: clock.now() + HOUR,
      closesAt: clock.now() + 2 * HOUR,
    });
    expect(((await edited.json()) as Ev).status).toBe('upcoming');
    clock.advance(5 * HOUR);
    expect(((await (await call('GET', `/${body.id}`)).json()) as Ev).status).toBe('ended');
    expect(await auditActions()).toEqual(['scan_event.create', 'scan_event.update']);
  });

  it('lists by mode and org, filters by status and pages', async () => {
    const other = await makeOrg(f);
    const a = await create({
      name: 'A',
      opensAt: clock.now() - 3 * HOUR,
      closesAt: clock.now() - 2 * HOUR,
    });
    const b = await create({ name: 'B' });
    await create({ name: 'T' }, admin('test'));
    await create({ orgId: other.id, name: 'Other', templateIds: [await template(other.id)] });
    const page = async (q: string, headers = admin()) =>
      (await (await call('GET', q, undefined, headers)).json()) as {
        items: Ev[];
        nextCursor: string | null;
      };
    expect((await page(`?orgId=${orgId}`)).items.map((e) => e.id)).toEqual([b.body.id, a.body.id]);
    expect((await page(`?orgId=${orgId}`, admin('test'))).items).toHaveLength(1);
    expect((await page(`?orgId=${orgId}&status=ended`)).items.map((e) => e.id)).toEqual([
      a.body.id,
    ]);
    expect((await page(`?orgId=${orgId}&status=live`)).items.map((e) => e.id)).toEqual([b.body.id]);
    const one = await page(`?orgId=${orgId}&limit=1`);
    expect(one.nextCursor).toBe(b.body.id);
    expect((await page(`?orgId=${orgId}&limit=1&cursor=${one.nextCursor}`)).items[0]?.id).toBe(
      a.body.id,
    );
    expect((await page(`?orgId=${orgId}&q=b`)).items.map((e) => e.id)).toEqual([b.body.id]);
  });

  it('validates the window, the templates and the match input', async () => {
    expect((await create({ closesAt: clock.now() - 2 * HOUR })).res.status).toBe(422);
    expect(
      (
        await create({
          templateIds: [
            await template(orgId, {
              scan: { actions: [{ id: 'add', label: 'Add', kind: 'add' }] },
            }),
          ],
        })
      ).res.status,
    ).toBe(422);
    const noInput = await create({ match: { input: 'nope', values: ['x'] } });
    expect(noInput.res.status).toBe(422);
    const nested = await template(orgId, {
      inputs: {
        type: 'object',
        properties: { tags: { type: 'array' }, memberName: { type: 'string' } },
      },
    });
    const arr = await create({ templateIds: [nested], match: { input: 'tags', values: ['x'] } });
    expect(arr.res.status).toBe(422);
    expect(await codeOf(arr.res)).toBe('EVENT_MATCH_INPUT');
    expect(
      (await create({ match: { input: 'memberName', values: ['Alex Morgan'] } })).res.status,
    ).toBe(201);
    const bad = await call('PATCH', `/${(await create()).body.id}`, {
      closesAt: clock.now() - 5 * HOUR,
    });
    expect(bad.status).toBe(422);
  });

  it("another org's templates are a 404", async () => {
    const other = await makeOrg(f);
    const theirs = await template(other.id);
    expect((await create({ templateIds: [theirs] })).res.status).toBe(404);
    const { body } = await create();
    expect((await call('PATCH', `/${body.id}`, { templateIds: [theirs] })).status).toBe(404);
  });

  it('the staff note: over 140 characters or with a control character is a 422; clearing stores NULL', async () => {
    expect((await create({ note: 'x'.repeat(141) })).res.status).toBe(422);
    expect((await create({ note: 'line\nbreak' })).res.status).toBe(422);
    const { body } = await create({ note: 'VIP list at the desk.' });
    expect(body.note).toBe('VIP list at the desk.');
    const cleared = await call('PATCH', `/${body.id}`, { note: null });
    expect(((await cleared.json()) as Ev).note).toBeNull();
    expect(
      (
        await first<{ note: string | null }>(env.DB, 'SELECT note FROM scan_events WHERE id = ?', [
          body.id,
        ])
      )?.note,
    ).toBeNull();
  });

  it('expected honours the match rule and is cached for a minute', async () => {
    const made = makeTemplate({ id: f.ids.id(), orgId });
    Object.assign(made.resolved.manifest, {
      inputs: {
        type: 'object',
        required: ['memberName'],
        properties: { memberName: { type: 'string' }, tier: { type: 'string' } },
      },
    });
    await persistTemplate(f, made.resolved);
    const t = made.resolved.id;
    const seed = async (tier: string, over: { status?: string; mode?: string } = {}) => {
      const pass = await makePass(f, {
        orgId,
        template: made.resolved,
        personalization: { memberName: 'M', tier },
      });
      await run(env.DB, 'UPDATE passes SET status = ?, mode = ? WHERE id = ?', [
        over.status ?? 'active',
        over.mode ?? 'live',
        pass.id,
      ]);
    };
    await seed('gold');
    await seed('gold');
    await seed('silver');
    await seed('gold', { status: 'voided' });
    await seed('gold', { mode: 'test' });
    const all1 = await create({ templateIds: [t] });
    expect(all1.body.expected).toBe(3);
    const gold = await create({
      templateIds: [t],
      match: { input: 'tier', values: ['gold', 'bronze'] },
    });
    expect(gold.body.expected).toBe(2);
    await seed('gold');
    expect(((await (await call('GET', `/${gold.body.id}`)).json()) as Ev).expected).toBe(2);
    clock.advance(61_000);
    expect(((await (await call('GET', `/${gold.body.id}`)).json()) as Ev).expected).toBe(3);
  });

  it('arrived counts the event gates, not undone ones', async () => {
    const made = makeTemplate({ id: f.ids.id(), orgId });
    await persistTemplate(f, made.resolved);
    const { body } = await create({ templateIds: [made.resolved.id] });
    const gate = async (state: string) => {
      const pass = await makePass(f, { orgId, template: made.resolved });
      await run(
        env.DB,
        `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
         VALUES (?, 'check_in', ?, ?, 'live', ?, 'check_in', ?, 1, 1, 1, 's')`,
        [pass.id, `event:${body.id}`, orgId, made.resolved.id, state],
      );
    };
    await gate('in');
    await gate('undone');
    await gate('out');
    expect(((await (await call('GET', `/${body.id}`)).json()) as Ev).arrived).toBe(2);
  });
});

describe('assign and archive', () => {
  it('assigning moves a scanner off its old event', async () => {
    const e1 = (await create()).body;
    const e2 = (await create()).body;
    const s = await makeScanner(f, { orgId, eventId: e1.id });
    const res = await call('POST', `/${e2.id}/scanners`, { scannerIds: [s.id] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Ev).scanners).toBe(1);
    expect(((await (await call('GET', `/${e1.id}`)).json()) as Ev).scanners).toBe(0);
    expect(
      (
        await first<{ event_id: string }>(env.DB, 'SELECT event_id FROM scanners WHERE id = ?', [
          s.id,
        ])
      )?.event_id,
    ).toBe(e2.id);
    expect(await auditActions()).toContain('scan_event.assign');
  });

  it("another org's scanner is a 404, another mode's a 422 SCAN_MODE_MISMATCH", async () => {
    const e = (await create()).body;
    const other = await makeOrg(f);
    const theirs = await makeScanner(f, { orgId: other.id });
    expect((await call('POST', `/${e.id}/scanners`, { scannerIds: [theirs.id] })).status).toBe(404);
    const testScanner = await makeScanner(f, { orgId, mode: 'test' });
    const res = await call('POST', `/${e.id}/scanners`, { scannerIds: [testScanner.id] });
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('SCAN_MODE_MISMATCH');
    const screen = await makeScanner(f, { orgId, kind: 'display', deviceRole: 'monitor' });
    expect((await call('POST', `/${e.id}/scanners`, { scannerIds: [screen.id] })).status).toBe(422);
  });

  it('archiving detaches every scanner, leaves the session unassigned and bumps configRev', async () => {
    const e = (await create()).body;
    const s = await makeScanner(f, { orgId, eventId: e.id });
    const before =
      (
        await first<{ updated_at: number }>(
          env.DB,
          'SELECT updated_at FROM scanners WHERE id = ?',
          [s.id],
        )
      )?.updated_at ?? 0;
    clock.advance(7_000);
    const res = await call('POST', `/${e.id}/archive`);
    expect(((await res.json()) as Ev).status).toBe('archived');
    const row = await first<{ event_id: string | null; updated_at: number }>(
      env.DB,
      'SELECT event_id, updated_at FROM scanners WHERE id = ?',
      [s.id],
    );
    expect(row).toEqual({ event_id: null, updated_at: before + 7_000 });
    expect((await call('POST', `/${e.id}/scanners`, { scannerIds: [s.id] })).status).toBe(422);
    expect((await call('POST', `/${e.id}/archive`)).status).toBe(200);
    expect((await auditActions()).filter((a) => a === 'scan_event.archive')).toHaveLength(1);
    const again = await call('PATCH', `/${e.id}`, { archived: false });
    expect(((await again.json()) as Ev).status).toBe('live');
  });

  it('an event is a 404 for the wrong id and needs an admin', async () => {
    expect((await call('GET', '/missing')).status).toBe(404);
    expect((await call('GET', '', undefined, fake.user())).status).toBe(403);
    await makeScanEvent(f, { orgId });
  });
});
