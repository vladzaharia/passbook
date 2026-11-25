import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all } from '../../platform/db.ts';
import type { MailMessage } from '../delivery/mailer.ts';
import { overrideDeps } from '../passes/deps.ts';
import { ACCESS, accessTemplate, grantOf, makeDoor } from './access-test-fixtures.ts';
import { CHECK_IN, HOUR, kit, setupActionFixture } from './act-test-fixtures.ts';
import {
  personInside,
  presenceOf,
  station,
  trackedZone,
  useKit,
} from './occupancy/whos-in-test-fixtures.ts';
import { key } from './test-kit.ts';

let tpl: string;
const sent: MailMessage[] = [];
beforeAll(async () => {
  await setupActionFixture();
  useKit(kit);
  tpl = await accessTemplate(ACCESS);
  overrideDeps(kit.env, {
    mailer: {
      async send(m) {
        sent.push(m);
        return { messageId: 'm1' };
      },
    },
  });
});

const signOut = (headers: Record<string, string>, passId: string) =>
  kit.post(headers, '/sign-out', { idempotencyKey: key(), passId, tag: 'none' });

describe('POST /scan/sign-out', () => {
  it('marks the person out of every place they are in, then answers NOT_INSIDE', async () => {
    const [a, b] = [await trackedZone(), await trackedZone()];
    const places = [`zone:${a.id}`, `zone:${b.id}`];
    const pass = await personInside(tpl, 'Leo Park', places, { at: kit.clock.now() - HOUR });
    const desk = await station([tpl], [a.id, b.id]);

    const res = await signOut(desk.headers, pass.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ passId: pass.id, stayMs: HOUR, tag: 'none' });
    for (const place of places) expect((await presenceOf(pass.id, place))[0]?.state).toBe('out');

    const again = await signOut(desk.headers, pass.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'NOT_INSIDE' });
  });

  it('answers NOT_INSIDE for a pass that was never inside', async () => {
    const zone = await trackedZone();
    const desk = await station([tpl], [zone.id]);
    const pass = await kit.scanPass(tpl, { plan: 'guest', memberName: 'Mia Stone' });
    const res = await signOut(desk.headers, pass.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'NOT_INSIDE' });
  });

  it("will not sign out another org's pass", async () => {
    const other = await makeOrg(kit.fx);
    const template = await kit.scanTemplate(
      'Guest',
      { actions: [CHECK_IN], access: ACCESS },
      { orgId: other.id },
    );
    const foreign = await kit.scanPass(template, { plan: 'guest' }, { orgId: other.id });
    const desk = await station([tpl], []);
    expect((await signOut(desk.headers, foreign.id)).status).toBe(404);
  });

  it('is refused at a door device', async () => {
    const door = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'guest' });
    expect([401, 403]).toContain((await signOut(door.headers, pass.id)).status);
  });
});

describe('check-in', () => {
  it('sends no email to anyone and records no visit', async () => {
    sent.length = 0;
    const door = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'guest', memberName: 'Leo Park' });
    expect(await grantOf(door.headers, pass)).toMatchObject({ kind: 'ok' });
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(0);
    const tables = await all<{ name: string }>(
      kit.env.DB,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'visitors'",
    );
    expect(tables).toEqual([]);
  });
});
