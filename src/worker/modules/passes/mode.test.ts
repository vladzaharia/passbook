import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { PassDetailSchema, PassListSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { enqueuePassEmail } from '../delivery/service.ts';
import { listMyPasses } from '../me/service.ts';
import { getOverview } from '../metrics/service.ts';
import { createPassRow } from './create.ts';
import { getPass } from './repo.ts';
import { type Kit, setupKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;
let otherOrg: { id: string };

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
  otherOrg = await makeOrg(kit.fx, { name: 'Other Org' });
});

type Headers = Record<string, string>;
const api = (path: string, init: RequestInit & { headers?: Headers } = {}) =>
  app.request(`${ORIGIN}/api/v1${path}`, init, kit.env);
const create = (headers: Headers, orgId = kit.org.id) =>
  api('/passes', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      orgId,
      templateId: kit.template.id,
      input: { memberName: 'Mode Test' },
    }),
  });
const list = async (headers: Headers, query = '') =>
  PassListSchema.parse(await (await api(`/passes?limit=200${query}`, { headers })).json()).items;

describe('a pass takes the creator mode', () => {
  it('admin sessions follow x-passbook-mode; anything but test is live', async () => {
    const live = PassDetailSchema.parse(await (await create(fake.admin())).json());
    const test = PassDetailSchema.parse(await (await create(fake.admin({ mode: 'test' }))).json());
    const odd = PassDetailSchema.parse(
      await (await create({ ...fake.admin(), 'x-passbook-mode': 'TESTING' })).json(),
    );
    expect([live.mode, test.mode, odd.mode]).toEqual(['live', 'test', 'live']);
    expect((await getPass(kit.env.DB, test.id))?.mode).toBe('test');
  });

  it('API keys follow api_keys.mode and ignore the header', async () => {
    const fromTest = PassDetailSchema.parse(
      await (await create(fake.apiKey({ mode: 'test' }))).json(),
    );
    const fromLive = PassDetailSchema.parse(
      await (await create({ ...fake.apiKey(), 'x-passbook-mode': 'test' })).json(),
    );
    expect([fromTest.mode, fromLive.mode]).toEqual(['test', 'live']);
  });

  it('connection syncs always create live passes', async () => {
    const pass = await createPassRow(kit.ctx, {
      orgId: kit.org.id,
      templateId: kit.template.id,
      input: { memberName: 'Synced' },
      source: 'connection',
      mode: 'test',
      actor: { type: 'system', id: null },
    });
    expect(pass.mode).toBe('live');
  });
});

describe('lists filter by the caller mode; get by id works in both', () => {
  it('splits live and test for admins and keys, inside tenant scope', async () => {
    const live = PassDetailSchema.parse(await (await create(fake.admin())).json());
    const test = PassDetailSchema.parse(await (await create(fake.admin({ mode: 'test' }))).json());
    const otherTest = PassDetailSchema.parse(
      await (await create(fake.admin({ mode: 'test' }), otherOrg.id)).json(),
    );
    const ids = (items: { id: string }[]) => items.map((p) => p.id);

    const adminLive = ids(await list(fake.admin()));
    expect(adminLive).toContain(live.id);
    expect(adminLive).not.toContain(test.id);
    const adminTest = ids(await list(fake.admin({ mode: 'test' })));
    expect(adminTest).toContain(test.id);
    expect(adminTest).not.toContain(live.id);
    expect(adminTest).toContain(otherTest.id);

    const keyTest = ids(await list(fake.apiKey({ mode: 'test', orgId: kit.org.id })));
    expect(keyTest).toContain(test.id);
    expect(keyTest).not.toContain(otherTest.id);
    expect(keyTest).not.toContain(live.id);
    const keyLive = ids(await list(fake.apiKey({ orgId: kit.org.id })));
    expect(keyLive).toContain(live.id);
    expect(keyLive).not.toContain(test.id);

    // Sessions read either mode by id; a key reads only its own.
    for (const headers of [
      fake.admin(),
      fake.admin({ mode: 'test' }),
      fake.apiKey({ mode: 'test' }),
    ]) {
      const got = PassDetailSchema.parse(
        await (await api(`/passes/${test.id}`, { headers })).json(),
      );
      expect(got.mode).toBe('test');
    }
    expect(
      (await api(`/passes/${test.id}`, { headers: fake.apiKey({ mode: 'live' }) })).status,
    ).toBe(404);
    // A key of another org cannot read it in either mode.
    expect(
      (
        await api(`/passes/${test.id}`, {
          headers: fake.apiKey({ orgId: otherOrg.id, mode: 'test' }),
        })
      ).status,
    ).toBe(404);
  });
});

describe('holders and metrics', () => {
  it('a holder sees test and live passes together', async () => {
    const user = await makeUser(kit.fx);
    const live = await kit.pass();
    const test = await createPassRow(kit.ctx, {
      orgId: kit.org.id,
      templateId: kit.template.id,
      input: { memberName: 'Holder Test' },
      source: 'manual',
      mode: 'test',
      actor: { type: 'system', id: null },
    });
    await run(kit.env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id IN (?, ?)', [
      user.id,
      live.id,
      test.id,
    ]);
    const mine = await listMyPasses(kit.ctx, user.id, { limit: 50 });
    expect(mine.items.map((p) => p.id).sort()).toEqual([live.id, test.id].sort());
    expect(mine.items.find((p) => p.id === test.id)?.mode).toBe('test');
  });

  it('overview totals count only the caller mode', async () => {
    const org = await makeOrg(kit.fx, { name: 'Metrics Org' });
    const make = (mode: 'live' | 'test') =>
      createPassRow(kit.ctx, {
        orgId: org.id,
        templateId: kit.template.id,
        input: { memberName: `M ${mode}` },
        source: 'manual',
        mode,
        actor: { type: 'system', id: null },
      });
    await make('live');
    await make('test');
    await make('test');
    const q = { orgId: org.id, range: '24h' as const };
    expect((await getOverview(kit.ctx, q, 'live')).totals).toMatchObject({ passes: 1, issued: 1 });
    expect((await getOverview(kit.ctx, q, 'test')).totals).toMatchObject({ passes: 2, issued: 2 });
  });
});

describe('test-mode email is never sent', () => {
  it('captures the message, ends the outbox row sent/TEST_MODE and records email.captured', async () => {
    const pass = await createPassRow(kit.ctx, {
      orgId: kit.org.id,
      templateId: kit.template.id,
      input: { memberName: 'Mail Test' },
      source: 'manual',
      mode: 'test',
      actor: { type: 'system', id: null },
    });
    const before = kit.mailer.sent.length;
    const { outboxId } = await enqueuePassEmail(kit.ctx, {
      passId: pass.id,
      to: 'holder-test-mode@example.com',
      attach: false,
    });
    await handleEmailSend({ kind: 'email.send', outboxId }, kit.ctx);
    expect(kit.mailer.sent).toHaveLength(before);
    expect(
      await first(kit.env.DB, 'SELECT state, error_code FROM outbox WHERE id = ?', [outboxId]),
    ).toEqual({ state: 'sent', error_code: 'TEST_MODE' });
    expect(
      await first(
        kit.env.DB,
        'SELECT recipient, pass_id FROM captured_emails WHERE outbox_id = ?',
        [outboxId],
      ),
    ).toEqual({ recipient: 'holder-test-mode@example.com', pass_id: pass.id });
    const events = await all<{ kind: string; mode: string; data: string }>(
      kit.env.DB,
      "SELECT kind, mode, data FROM pass_events WHERE pass_id = ? AND kind = 'email.captured'",
      [pass.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.mode).toBe('test');
    expect(events[0]?.data).not.toContain('example.com');
  });

  it('still sends for live passes', async () => {
    const pass = await kit.pass();
    const before = kit.mailer.sent.length;
    const { outboxId } = await enqueuePassEmail(kit.ctx, {
      passId: pass.id,
      to: 'holder-live-mode@example.com',
      attach: false,
    });
    await handleEmailSend({ kind: 'email.send', outboxId }, kit.ctx);
    expect(kit.mailer.sent).toHaveLength(before + 1);
  });
});
