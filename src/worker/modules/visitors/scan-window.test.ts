import { beforeAll, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { ACCESS, accessTemplate } from '../scan/access-test-fixtures.ts';
import { HOUR, kit, setupActionFixture } from '../scan/act-test-fixtures.ts';
import { station, useKit } from '../scan/occupancy/whos-in-test-fixtures.ts';

let tpl: string;
beforeAll(async () => {
  await setupActionFixture();
  useKit(kit);
  tpl = await accessTemplate(ACCESS);
});

async function visit(from: number, until: number, name: string) {
  const pass = await kit.scanPass(tpl, { plan: 'guest', memberName: name });
  const id = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO visitors (id, org_id, mode, pass_id, name, host_name, host_email, window_from, window_until, note, created_at)
     VALUES (?, ?, 'live', ?, ?, 'Ana Ruiz', 'ana@host.test', ?, ?, 'n', ?)`,
    [id, kit.org.id, pass.id, name, from, until, kit.clock.now()],
  );
  return id;
}

type Items = { items: { id: string }[] };

it('a desk device sees only today in the session zone, whatever range it asks for', async () => {
  const now = kit.clock.now();
  const old = await visit(now - 400 * 24 * HOUR, now - 399 * 24 * HOUR, 'Old Visitor');
  const lastWeek = await visit(now - 3 * 24 * HOUR, now - 3 * 24 * HOUR + HOUR, 'Week Visitor');
  const future = await visit(now + 300 * 24 * HOUR, now + 301 * 24 * HOUR, 'Future Visitor');
  const here = await visit(now - HOUR, now + HOUR, 'Here Visitor');
  const desk = await station([tpl], []);
  const res = await kit.get(desk.headers, `/visitors?dayStart=0&dayEnd=${now + 1000 * 24 * HOUR}`);
  expect(res.status).toBe(200);
  const ids = ((await res.json()) as Items).items.map((v) => v.id);
  expect(ids).toContain(here);
  for (const id of [old, lastWeek, future]) expect(ids).not.toContain(id);
});

it('a manager reaches back at most 7 days', async () => {
  const now = kit.clock.now();
  const old = await visit(now - 30 * 24 * HOUR, now - 29 * 24 * HOUR, 'Old Visitor');
  const lastWeek = await visit(now - 3 * 24 * HOUR, now - 3 * 24 * HOUR + HOUR, 'Week Visitor');
  const desk = await station([tpl], [], { signedIn: true });
  const manager = await kit.staff('manager');
  await run(kit.env.DB, 'UPDATE scanners SET staff_id = ? WHERE id = ?', [
    manager.id,
    desk.scanner.id,
  ]);
  const res = await kit.get(desk.headers, `/visitors?dayStart=0&dayEnd=${now + 24 * HOUR}`);
  expect(res.status).toBe(200);
  const ids = ((await res.json()) as Items).items.map((v) => v.id);
  expect(ids).toContain(lastWeek);
  expect(ids).not.toContain(old);
});
