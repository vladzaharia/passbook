import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanWhosInList } from '../../../../shared/contracts/scan-whos-in.ts';
import { accessTemplate } from '../access-test-fixtures.ts';
import { kit, setupActionFixture } from '../act-test-fixtures.ts';
import {
  DISPLAY_TPL,
  personInside,
  station,
  trackedZone,
  useKit,
} from './whos-in-test-fixtures.ts';

let tpl: string;
beforeAll(async () => {
  await setupActionFixture();
  useKit(kit);
  tpl = await kit.scanTemplate('Gym', DISPLAY_TPL as never);
});

const list = async (h: Record<string, string>, qs = '') => {
  const res = await kit.get(h, `/live/inside${qs}`);
  return { status: res.status, body: (await res.json()) as ScanWhosInList & { code?: string } };
};

describe("who's in: who may ask", () => {
  it('serves a Desk-role scanner its session places, longest first, with count and revs', async () => {
    const pool = await trackedZone();
    const other = await trackedZone();
    const now = kit.clock.now();
    await personInside(tpl, 'Ana Reyes', [`zone:${pool.id}`], { at: now - 2000 });
    await personInside(tpl, 'Ben Okoro', [`zone:${pool.id}`], { at: now - 5000 });
    await personInside(tpl, 'Not Here', [`zone:${other.id}`]);
    const s = await station([tpl], [pool.id]);
    const { status, body } = await list(s.headers);
    expect(status).toBe(200);
    expect(body.items.map((i) => i.holder)).toEqual(['Ben Okoro', 'Ana Reyes']);
    expect(body.count).toBe(2);
    expect(body.places).toMatchObject([{ place: `zone:${pool.id}`, name: pool.name, inNow: 2 }]);
    expect(JSON.stringify(body)).not.toContain('Not Here');
  });

  it('refuses a Door role, a customer screen and a monitor without Desk actions, and names nobody', async () => {
    const pool = await trackedZone();
    await personInside(tpl, 'Private Person', [`zone:${pool.id}`]);
    for (const [opts, code] of [
      [{ role: 'door' }, 'FORBIDDEN'],
      [{ deviceRole: 'customer' }, 'SCREEN_ONLY'],
      [{ deviceRole: 'monitor' }, 'SCREEN_ONLY'],
      [{ deviceRole: 'monitor', deskActions: false }, 'SCREEN_ONLY'],
    ] as const) {
      const s = await station([tpl], [pool.id], opts);
      const res = await kit.get(s.headers, '/live/inside');
      expect(res.status, JSON.stringify(opts)).toBe(403);
      const text = await res.text();
      expect(text).toContain(code);
      expect(text).not.toContain('Private Person');
    }
  });

  it('serves a monitor with Desk actions on', async () => {
    const pool = await trackedZone();
    await personInside(tpl, 'Monitor Sees', [`zone:${pool.id}`]);
    const s = await station([tpl], [pool.id], {
      deviceRole: 'monitor',
      deskActions: true,
      signedIn: true,
    });
    const { status, body } = await list(s.headers);
    expect(status).toBe(200);
    expect(body.items.map((i) => i.holder)).toEqual(['Monitor Sees']);
  });

  it('names nobody to a monitor that nobody is signed in on, whatever the sign-in setting', async () => {
    const pool = await trackedZone();
    await personInside(tpl, 'Unattended', [`zone:${pool.id}`]);
    const s = await station([tpl], [pool.id], { deviceRole: 'monitor', deskActions: true });
    const res = await kit.get(s.headers, '/live/inside');
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('STAFF_REQUIRED');
    expect(text).not.toContain('Unattended');
  });

  it('needs a signed-in person when staff sign-in is on', async () => {
    const pool = await trackedZone();
    const s = await station([tpl], [pool.id], { staffSignIn: true });
    const res = await kit.get(s.headers, '/live/inside');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('STAFF_REQUIRED');
  });
});

describe("who's in: isolation, filter and paging", () => {
  it('lists the mode and org of the session only', async () => {
    const pool = await trackedZone();
    await personInside(tpl, 'Live One', [`zone:${pool.id}`]);
    await personInside(tpl, 'Test One', [`zone:${pool.id}`], { mode: 'test' });
    const s = await station([tpl], [pool.id]);
    const { body } = await list(s.headers);
    expect(body.items.map((i) => i.holder)).toEqual(['Live One']);
    expect(body.count).toBe(1);
  });

  it('a place outside the session scope answers empty', async () => {
    const pool = await trackedZone();
    const other = await trackedZone();
    await personInside(tpl, 'Elsewhere', [`zone:${other.id}`]);
    const s = await station([tpl], [pool.id]);
    const { body } = await list(s.headers, `?place=zone:${other.id}`);
    expect(body).toMatchObject({ items: [], count: 0 });
  });

  it('shows a pass once, at its deepest place, with the zone above it', async () => {
    const gym = await trackedZone();
    const pool = await trackedZone({ parentId: gym.id });
    await personInside(tpl, 'Deep Diver', [`zone:${gym.id}`, `zone:${pool.id}`]);
    await personInside(tpl, 'Gym Only', [`zone:${gym.id}`]);
    const s = await station([tpl], [gym.id]);
    const { body } = await list(s.headers);
    expect(body.count).toBe(2);
    const rows = Object.fromEntries(body.items.map((i) => [i.holder, i]));
    expect(rows['Deep Diver']).toMatchObject({ placeName: pool.name, parentName: gym.name });
    expect(rows['Gym Only']).toMatchObject({ placeName: gym.name, parentName: null });
    expect(body.items).toHaveLength(2);
    const one = await list(s.headers, `?place=zone:${gym.id}`);
    expect(one.body.items).toHaveLength(2);
  });

  it('filters by name and pages with a cursor', async () => {
    const pool = await trackedZone();
    const now = kit.clock.now();
    for (const [i, name] of ['Mia Ito', 'Mia Park', 'Noor Ali', 'Mia Cho', 'Zed Zed'].entries())
      await personInside(tpl, name, [`zone:${pool.id}`], { at: now - 10_000 + i });
    const s = await station([tpl], [pool.id]);
    const mia = await list(s.headers, '?q=mia');
    expect(mia.body.items.map((i) => i.holder)).toEqual(['Mia Ito', 'Mia Park', 'Mia Cho']);
    expect(mia.body.count).toBe(5);
    const first = await list(s.headers, '?q=mia&limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    const rest = await list(
      s.headers,
      `?q=mia&limit=2&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
    );
    expect(rest.body.items.map((i) => i.holder)).toEqual(['Mia Cho']);
    expect(rest.body.nextCursor).toBeNull();
    const all = await list(s.headers, '?limit=2');
    expect(all.body.items).toHaveLength(2);
    expect(all.body.nextCursor).not.toBeNull();
  });

  it('flags a long stay and a row past due reads as out', async () => {
    const pool = await trackedZone({ maxStayMinutes: 60 });
    const now = kit.clock.now();
    await personInside(tpl, 'Long Stay', [`zone:${pool.id}`], {
      at: now - 50 * 60_000,
      dueAt: now + 10 * 60_000,
    });
    await personInside(tpl, 'Past Due', [`zone:${pool.id}`], {
      at: now - 90 * 60_000,
      dueAt: now - 1,
    });
    const s = await station([tpl], [pool.id]);
    const { body } = await list(s.headers);
    expect(body.items).toMatchObject([{ holder: 'Long Stay', flags: ['long_stay'] }]);
  });
});

describe("who's in: access plan and host", () => {
  it('names the plan and a visitor host, and leaves the host null when there is none', async () => {
    const acc = await accessTemplate();
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const now = kit.clock.now();
    await personInside(acc, 'Visitor', [place], {
      at: now - 2000,
      input: { plan: 'guest', visits: 2, sponsor: 'Ana R.' },
    });
    await personInside(acc, 'Member', [place], { at: now - 1000, input: { plan: 'gold' } });
    const s = await station([acc], [pool.id]);
    const { body } = await list(s.headers);
    const rows = Object.fromEntries(body.items.map((i) => [i.holder, i]));
    expect(rows.Visitor).toMatchObject({ plan: 'Guest day', host: 'Ana R.' });
    expect(rows.Member).toMatchObject({ plan: '24/7 Gold', host: null });
  });
});
