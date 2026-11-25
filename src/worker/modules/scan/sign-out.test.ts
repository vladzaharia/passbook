import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { MailMessage } from '../delivery/mailer.ts';
import { overrideDeps } from '../passes/deps.ts';
import { ACCESS, accessTemplate, grantOf, makeDoor } from './access-test-fixtures.ts';
import { CHECK_IN, HOUR, kit, setupActionFixture } from './act-test-fixtures.ts';
import { station, useKit } from './occupancy/whos-in-test-fixtures.ts';
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
  it('marks the person out of every place, and a pass with nothing to mark out is NOT_INSIDE', async () => {
    const door = await makeDoor([tpl]);
    const desk = await station([tpl], []);
    const pass = await kit.scanPass(tpl, { plan: 'guest', memberName: 'Leo Park' });
    const before = await signOut(desk.headers, pass.id);
    expect(before.status).toBe(409);
    expect(await before.json()).toMatchObject({ code: 'NOT_INSIDE' });

    expect(await grantOf(door.headers, pass)).toMatchObject({ kind: 'ok' });
    kit.clock.advance(HOUR);
    const res = await signOut(desk.headers, pass.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ passId: pass.id, stayMs: HOUR, tag: 'none' });

    const again = await signOut(desk.headers, pass.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'NOT_INSIDE' });
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
  it('sends no email to anyone', async () => {
    sent.length = 0;
    const door = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'guest', memberName: 'Leo Park' });
    await grantOf(door.headers, pass);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(0);
  });
});
