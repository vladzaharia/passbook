import { afterEach, beforeAll, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import type { AccessManifest } from '../../../passkit/types.ts';
import { run } from '../../platform/db.ts';
import { ACCESS, accessTemplate, grantOf, makeDoor } from './access-test-fixtures.ts';
import { HOUR, kit, setupActionFixture } from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

it('keeps a private plan label off access and admit', async () => {
  const label = 'plan-private@example.test';
  const manifest: AccessManifest = {
    ...ACCESS,
    plans: ACCESS.plans.map((p) => (p.id === 'guest' ? { ...p, label } : p)),
  };
  const tpl = await accessTemplate(manifest, 'Gym card');
  const d = await makeDoor([tpl]);
  const pass = await kit.scanPass(tpl, { plan: 'guest', visits: 2 });
  const out = await grantOf(d.headers, pass);
  expect(out.kind).toBe('ok');
  expect(JSON.stringify(out)).not.toContain(label);
  // A plan label that passes keeps showing, so the gate above is meaningful.
  const open = await grantOf(d.headers, await kit.scanPass(tpl, { plan: 'gold' }));
  expect(open.admit?.type).toBe('24/7 Gold');
});

async function atEvent(name: string) {
  const tpl = await kit.scanTemplate('Entry', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const event = await kit.event({ templateIds: [tpl], closesAt: TEST_NOW + 24 * HOUR });
  await run(kit.env.DB, 'UPDATE scan_events SET name = ? WHERE id = ?', [name, event.id]);
  const s = await kit.scanner({ eventId: event.id });
  const pass = await kit.scanPass(tpl);
  const response = await kit.post(s.headers, '/actions', {
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    idempotencyKey: key(),
    actionId: 'check_in',
  });
  return response.text();
}

it('keeps a private event name out of admit', async () => {
  const name = 'event-private@example.test';
  expect(await atEvent(name)).not.toContain(name);
});

it('names a plain event in admit', async () => {
  const body = JSON.parse(await atEvent('Summer Gala'));
  expect(body.admit?.rule).toEqual({ kind: 'event', name: 'Summer Gala' });
});

it('keeps a private plan label out of a refusal, display included', async () => {
  const label = 'plan-private@example.test';
  const manifest: AccessManifest = {
    ...ACCESS,
    plans: ACCESS.plans.map((p) => (p.id === 'guest' ? { ...p, label } : p)),
  };
  const tpl = await accessTemplate(manifest, 'Gym card');
  const d = await makeDoor([tpl]);
  const pass = await kit.scanPass(tpl, { plan: 'guest', visits: 1 });
  expect((await grantOf(d.headers, pass)).kind).toBe('ok');
  kit.clock.advance(3 * HOUR);
  const refused = await grantOf(d.headers, pass);
  expect(refused).toMatchObject({ kind: 'refused', reason: 'guest_visits_used' });
  expect(refused.display).not.toBeNull();
  expect(JSON.stringify(refused)).not.toContain(label);
});
