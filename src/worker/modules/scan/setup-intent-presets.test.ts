import { beforeAll, describe, expect, it } from 'vitest';
import { all, first } from '../../platform/db.ts';
import { door, fixture, made, post } from './setup-intent-test-fixtures.ts';

let templateId: string;
beforeAll(async () => {
  await fixture.setup();
  templateId = await fixture.kit.scanTemplate('Preset pass', {
    actions: [{ id: 'entry', label: 'Check in', kind: 'check_in' }],
  });
});

const orgId = () => fixture.kit.org.id;
const stored = async (sessionId: string) => {
  const row = await first<{ settings: string }>(
    fixture.kit.env.DB,
    'SELECT settings FROM scanning_sessions WHERE id = ?',
    [sessionId],
  );
  return JSON.parse(row?.settings ?? '{}') as Record<string, unknown>;
};
const devices = (sessionId: string) =>
  all<{ surface: string; overrides: string }>(
    fixture.kit.env.DB,
    'SELECT surface, overrides FROM scanning_devices WHERE session_id = ? ORDER BY rowid',
    [sessionId],
  );

describe('gates preset', () => {
  it('makes three devices with a barcode reader on the third, single entry and the offline list', async () => {
    const result = await made(
      await post({
        orgId: orgId(),
        preset: 'gates',
        doors: [door(templateId, { name: 'Gate A' })],
      }),
    );
    const [session] = result.sessions;
    expect(session?.devices).toHaveLength(3);
    const rows = await devices(session?.id ?? '');
    expect(rows.map((d) => JSON.parse(d.overrides).reader)).toEqual([
      undefined,
      undefined,
      'barcode',
    ]);
    const settings = await stored(session?.id ?? '');
    expect(settings).toMatchObject({
      staffSignIn: false,
      checkIn: { mode: 'single' },
      offline: true,
      whenOffline: 'list',
    });
  });
});

describe('counter preset', () => {
  it('makes an operator and a customer screen, with staff signing in by PIN', async () => {
    const result = await made(
      await post({
        orgId: orgId(),
        preset: 'counter',
        staff: [{ name: 'Rae', role: 'desk' }],
        doors: [door(templateId, { name: 'Counter' })],
      }),
    );
    const [session] = result.sessions;
    expect(result.staff[0]?.pin).toMatch(/^\d{6}$/);
    expect((await devices(session?.id ?? '')).map((d) => d.surface)).toEqual([
      'operator',
      'customer',
    ]);
    expect(await stored(session?.id ?? '')).toMatchObject({
      staffSignIn: true,
      flow: 'choose',
      checkIn: { mode: 'unlimited' },
      customer: { greet: true, showReady: true },
    });
  });
});

describe('capacity preset', () => {
  const place = (max?: number) => ({
    ref: 'hall',
    name: 'Hall',
    ...(max ? { max } : { count: true }),
  });
  it('is refused without a max, writing nothing', async () => {
    const res = await post({
      orgId: orgId(),
      preset: 'capacity',
      places: [place()],
      doors: [door(templateId, { name: 'Capacity none', place: 'hall' })],
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('SETUP_HARD_LIMIT_NO_CAPACITY');
  });
  it('is accepted with a max, with a hard limit and an in and an out phone', async () => {
    const result = await made(
      await post({
        orgId: orgId(),
        preset: 'capacity',
        timeZone: 'America/Los_Angeles',
        places: [place(30)],
        doors: [door(templateId, { name: 'Capacity ok', place: 'hall' })],
      }),
    );
    const [session] = result.sessions;
    expect(session?.devices).toHaveLength(2);
    expect(await stored(session?.id ?? '')).toMatchObject({
      hardLimit: true,
      checkIn: { mode: 'in_out' },
    });
  });
});

describe('unknown preset', () => {
  it('is refused with 422', async () => {
    const res = await post({
      orgId: orgId(),
      preset: 'spa',
      doors: [door(templateId, { name: 'Spa' })],
    });
    expect(res.status).toBe(422);
  });
});
