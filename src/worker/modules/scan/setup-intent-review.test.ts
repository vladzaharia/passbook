import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey } from '../../../../test/helpers/index.ts';
import type { ScanSetupPlan } from '../../../shared/contracts/scan-setup-intent.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createScannerStore } from './auth-store.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { door, fixture, made, newKey, post } from './setup-intent-test-fixtures.ts';

let templateId: string;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  await fixture.setup();
  const { kit } = fixture;
  templateId = await kit.scanTemplate('Review pass', {
    actions: [{ id: 'entry', label: 'Check in', kind: 'check_in' }],
  });
  app = createApp({
    stores: {
      ...fixture.fake.stores,
      apiKeys: createApiKeyStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

const orgId = () => fixture.kit.org.id;
const day = 86_400_000;
const dry = (body: unknown) => post(body, fixture.fake.admin(), null, '?dryRun=true');
const settingsOf = async (id: string) =>
  JSON.parse(
    (
      await first<{ settings: string }>(
        fixture.kit.env.DB,
        'SELECT settings FROM scanning_sessions WHERE id = ?',
        [id],
      )
    )?.settings ?? '{}',
  ) as Record<string, unknown>;
const gala = (reentry: boolean) => ({
  ref: 'gala',
  name: 'Re-entry gala',
  templateIds: [templateId],
  opensAt: fixture.kit.clock.now(),
  closesAt: fixture.kit.clock.now() + day,
  max: 100,
  reentry,
});

describe('event_night keeps the offline list off doors that need exits', () => {
  it('applies a re-entry event with in and out tracking and no offline list', async () => {
    const result = await made(
      await post({
        orgId: orgId(),
        preset: 'event_night',
        events: [gala(true)],
        doors: [{ name: 'Re-entry door', admits: { events: ['gala'] } }],
      }),
    );
    const settings = await settingsOf(result.sessions[0]?.id ?? '');
    expect(settings).toMatchObject({ direction: 'both', offline: false });
    expect(settings.checkIn).toMatchObject({ mode: 'in_out' });
  });

  it('applies a tracked place with the list off, and an entry-only door with it on', async () => {
    const tracked = await made(
      await post({
        orgId: orgId(),
        preset: 'event_night',
        places: [{ ref: 'hall', name: 'Event hall', max: 50 }],
        doors: [door(templateId, { name: 'Hall door', place: 'hall' })],
      }),
    );
    expect(await settingsOf(tracked.sessions[0]?.id ?? '')).toMatchObject({ offline: false });
    const plain = await made(
      await post({
        orgId: orgId(),
        preset: 'event_night',
        doors: [door(templateId, { name: 'Plain night door' })],
      }),
    );
    expect(await settingsOf(plain.sessions[0]?.id ?? '')).toMatchObject({
      offline: true,
      whenOffline: 'list',
    });
  });

  it('reports an explicit list on a door that needs exits in the dry run and refuses the apply', async () => {
    const body = {
      orgId: orgId(),
      events: [gala(true)],
      doors: [
        {
          name: 'Blocked door',
          admits: { events: ['gala'] },
          more: { offline: true, whenOffline: 'list' },
        },
      ],
    };
    const plan = (await (await dry(body)).json()) as ScanSetupPlan;
    expect(plan.checks).toContainEqual(
      expect.objectContaining({ code: 'OFFLINE_LIST_BLOCKED', level: 'error' }),
    );
    await expectProblem(await post(body), 422, 'SCAN_SETUP_CHECKS_FAILED');
  });
});

describe('a dry run gives the verdict apply gives', () => {
  it('refuses what a key may not do, with the same code', async () => {
    const k = await makeApiKey(fixture.kit.fx, { orgId: orgId(), scopes: ['scanning:write'] });
    const body = {
      orgId: orgId(),
      staff: [{ name: 'Dry Dana', role: 'door' }],
      doors: [door(templateId, { name: 'Dry key door' })],
    };
    const send = (query: string, key: string | null) =>
      app.request(
        `https://wallet.test/api/v1/scanning-sessions/setup${query}`,
        {
          method: 'POST',
          headers: {
            ...k.headers,
            'content-type': 'application/json',
            ...(key ? { 'idempotency-key': key } : {}),
          },
          body: JSON.stringify(body),
        },
        fixture.kit.env,
      );
    await expectProblem(await send('?dryRun=true', null), 403, 'SCAN_SETUP_ADMIN_SCOPE');
    await expectProblem(await send('', newKey()), 403, 'SCAN_SETUP_ADMIN_SCOPE');
  });

  it('refuses a per-object rule the planner does not see', async () => {
    const body = {
      orgId: orgId(),
      doors: [
        door(templateId, {
          name: 'Bad event door',
          admits: { events: ['0193a1b2-7c00-7000-8000-00000000dead'] },
        }),
      ],
    };
    const res = await dry(body);
    expect(res.status).toBe(422);
    expect((await post(body)).status).toBe(422);
  });
});

describe('the idempotency answer commits with the work', () => {
  it('is settled by the time the setup audit row is written', async () => {
    const key = newKey();
    const db = fixture.kit.env.DB;
    await run(
      db,
      `CREATE TRIGGER setup_unsettled BEFORE INSERT ON audit_log WHEN NEW.action = 'scan.setup.apply'
       BEGIN SELECT RAISE(ABORT, 'unsettled') WHERE EXISTS (
         SELECT 1 FROM idempotent_requests WHERE key = '${key}' AND status IS NULL); END`,
      [],
    );
    try {
      await made(
        await post(
          { orgId: orgId(), doors: [door(templateId, { name: 'Settled door' })] },
          fixture.fake.admin(),
          key,
        ),
      );
    } finally {
      await run(db, 'DROP TRIGGER setup_unsettled', []);
    }
    expect(await first(db, 'SELECT status FROM idempotent_requests WHERE key = ?', [key])).toEqual({
      status: 200,
    });
  });
});

describe('the contract maxima fit one grant', () => {
  it('applies 8 doors of 10 devices, 10 events each, 10 new events and 50 staff', async () => {
    const existing: string[] = [];
    for (let n = 0; n < 80; n++)
      existing.push((await fixture.kit.event({ templateIds: [templateId] })).id);
    const events = Array.from({ length: 10 }, (_, n) => ({
      ...gala(false),
      ref: `show-${n}`,
      name: `Show ${n}`,
    }));
    const body = {
      orgId: orgId(),
      events,
      staff: Array.from({ length: 50 }, (_, n) => ({ name: `Max Person ${n}`, role: 'door' })),
      doors: Array.from({ length: 8 }, (_, d) => ({
        name: `Max door ${d}`,
        admits: { events: existing.slice(d * 10, d * 10 + 10) },
        devices: Array.from({ length: 10 }, () => ({ layout: 'phone' })),
      })),
    };
    const res = await post(body);
    const result = await made(res);
    expect(result.sessions).toHaveLength(8);
    expect(result.sessions.flatMap((s) => s.devices)).toHaveLength(80);
    expect(result.staff).toHaveLength(50);
    expect(result.events.filter((e) => e.created)).toHaveLength(10);
  });
});

describe('a competing session that commits first', () => {
  it('is taken over by template scan setup, with no stray event', async () => {
    const { eventTemplate } = await import('./template-setup-test-fixtures.ts');
    const id = await eventTemplate(fixture.kit, 'Race ticket');
    const now = fixture.kit.clock.now();
    await fixture.kit.scanPass(id, {
      eventName: 'Race night',
      startsAt: new Date(now - 600_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
    });
    const db = fixture.kit.env.DB;
    const call = () =>
      fixture.call('POST', `/templates/${id}/scan-setup`, { orgId: orgId(), timeZone: 'UTC' });
    // The winner commits on its own the moment our batch starts, so ours fails on the unique index.
    const real = db.batch.bind(db);
    let armed = true;
    db.batch = (async (statements: D1PreparedStatement[]) => {
      if (armed) {
        armed = false;
        await run(
          db,
          `INSERT INTO scanning_sessions (id, org_id, mode, name, status, accepts, settings, time_zone,
             created_at, updated_at, setup_template_id)
           VALUES ('race-won', ?, 'live', 'Winner', 'active', ?, ?, 'UTC', 1, 1, ?)`,
          [
            orgId(),
            JSON.stringify({ templateIds: [id], eventIds: [] }),
            JSON.stringify(DEFAULT_SETTINGS),
            id,
          ],
        );
      }
      return real(statements);
    }) as typeof db.batch;
    let res: Response;
    try {
      res = await call();
    } finally {
      db.batch = real;
    }
    expect(res.status, await res.clone().text()).toBe(200);
    const answer = (await res.json()) as { created: boolean; session: { id: string } };
    expect(answer).toMatchObject({ created: false, session: { id: 'race-won' } });
    const events = await all<{ name: string }>(
      db,
      "SELECT name FROM scan_events WHERE org_id = ? AND archived_at IS NULL AND name = 'Race night'",
      [orgId()],
    );
    expect(events).toHaveLength(1);
  });
});
