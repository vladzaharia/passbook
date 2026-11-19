import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { ScanningSessionDetailSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { all, first, run } from '../../platform/db.ts';
import { admitsJson } from './admits.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
const template = (name: string, orgId?: string) =>
  fixture.kit.scanTemplate(name, { actions: [CHECK_IN] }, orgId ? { orgId } : {});
const create = (accepts: unknown, extra: Record<string, unknown> = {}) =>
  fixture.call('POST', '/scanning-sessions', {
    orgId: fixture.kit.org.id,
    name: 'Admits',
    timeZone: 'UTC',
    accepts,
    ...extra,
  });
const stored = async (id: string) =>
  (
    await first<{ accepts: string | null }>(
      fixture.kit.env.DB,
      'SELECT accepts FROM scanning_sessions WHERE id=?',
      [id],
    )
  )?.accepts;

describe('session admits', () => {
  it('stores a mix, gives devices the template entries, and admits through the event', async () => {
    const { kit, call, device, pair } = fixture;
    const entry = await template('Mixed entry');
    const ticket = await template('Mixed ticket');
    const event = await kit.event({ templateIds: [ticket] });
    const made = await create({ templateIds: [entry], eventIds: [event.id] });
    expect(made.status).toBe(201);
    const session = ScanningSessionDetailSchema.parse(await made.json());
    expect(session.accepts).toEqual({ templateIds: [entry], eventIds: [event.id] });
    expect(await stored(session.id)).toBe(
      admitsJson({ templateIds: [entry], eventIds: [event.id] }),
    );
    const dev = await device(session.id, 'Mixed door');
    expect(await first(kit.env.DB, 'SELECT event_id FROM scanners WHERE id=?', [dev.id])).toEqual({
      event_id: null,
    });
    expect(
      await all(kit.env.DB, 'SELECT template_id FROM scanner_templates WHERE scanner_id=?', [
        dev.id,
      ]),
    ).toEqual([{ template_id: entry }]);
    const headers = await pair(dev.pairing?.code ?? '');
    const pass = await kit.scanPass(ticket);
    const res = await call(
      'POST',
      '/scan/actions',
      {
        idempotencyKey: kit.fx.ids.ordered(),
        input: { code: pass.scanCode ?? '', method: 'camera' },
        clientTs: kit.clock.now(),
        actionId: 'auto',
      },
      headers,
    );
    const outcome = (await res.json()) as { kind: string; scanId: string };
    expect(outcome.kind).toBe('ok');
    expect(
      await first(kit.env.DB, 'SELECT event_id FROM scans WHERE id=?', [outcome.scanId]),
    ).toEqual({ event_id: event.id });
  });

  it('stores the legacy one-event form as lists and shows it as before', async () => {
    const event = await fixture.kit.event({ templateIds: [await template('Legacy event')] });
    const made = await create({ eventId: event.id });
    expect(made.status).toBe(201);
    const session = ScanningSessionDetailSchema.parse(await made.json());
    expect(session.accepts).toEqual({ eventId: event.id });
    expect(await stored(session.id)).toBe(admitsJson({ templateIds: [], eventIds: [event.id] }));
  });

  it("refuses another org's event or template and an event of the other mode", async () => {
    const { kit } = fixture;
    const own = await template('Own');
    const other = await makeOrg(kit.fx);
    const foreignTpl = await template('Foreign', other.id);
    const foreignEvent = await kit.event({ orgId: other.id, templateIds: [foreignTpl] });
    const testEvent = await kit.event({ mode: 'test', templateIds: [own] });
    const code = async (res: Response) => ((await res.json()) as { code?: string }).code;
    const event = await create({ templateIds: [own], eventIds: [foreignEvent.id] });
    expect([event.status, await code(event)]).toEqual([404, 'EVENT_NOT_FOUND']);
    const tpl = await create({ templateIds: [own, foreignTpl], eventIds: [] });
    expect([tpl.status, await code(tpl)]).toEqual([404, 'TEMPLATE_NOT_FOUND']);
    expect(await code(await create({ templateIds: [own], eventIds: [testEvent.id] }))).toBe(
      'SCAN_MODE_MISMATCH',
    );
  });

  it('takes zones beside template entries but not on an event-only session', async () => {
    const { kit } = fixture;
    const zone = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO scan_zones (id, org_id, key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [zone, kit.org.id, 'admits-zone', 'Zone', kit.clock.now(), kit.clock.now()],
    );
    const tpl = await template('Zoned');
    const event = await kit.event({ templateIds: [await template('Zoned event')] });
    expect(
      (await create({ templateIds: [tpl], eventIds: [event.id] }, { zoneIds: [zone] })).status,
    ).toBe(201);
    const eventOnly = await create({ templateIds: [], eventIds: [event.id] }, { zoneIds: [zone] });
    expect(((await eventOnly.json()) as { code?: string }).code).toBe('ZONE_EVENT_SESSION');
  });

  it('archiving an admitted event detaches every session that admits it', async () => {
    const { kit, call } = fixture;
    const event = await kit.event({ templateIds: [await template('Archived event')] });
    const made = await create({
      templateIds: [await template('Archive entry')],
      eventIds: [event.id],
    });
    const session = ScanningSessionDetailSchema.parse(await made.json());
    expect((await call('POST', `/scan-events/${event.id}/archive`)).status).toBe(200);
    expect(await stored(session.id)).toBeNull();
  });
});
