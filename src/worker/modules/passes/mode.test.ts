import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeAuth, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { PassDetailSchema, PassListSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { enqueuePassEmail } from '../delivery/service.ts';
import { listMyPasses } from '../me/service.ts';
import { getOverview } from '../metrics/service.ts';
import { type CreateParams, createPassRow } from './create.ts';
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
const create = (
  headers: Headers,
  orgId = kit.org.id,
  reviewedMode: 'live' | 'test' =
    !headers.authorization && headers['x-passbook-mode'] === 'test' ? 'test' : 'live',
) =>
  api('/passes', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      orgId,
      templateId: kit.template.id,
      templateVersion: kit.template.version,
      mode: reviewedMode,
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
      await (await create(fake.apiKey({ mode: 'test' }), kit.org.id, 'test')).json(),
    );
    const fromLive = PassDetailSchema.parse(
      await (await create({ ...fake.apiKey(), 'x-passbook-mode': 'test' })).json(),
    );
    expect([fromTest.mode, fromLive.mode]).toEqual(['test', 'live']);
  });

  it('requires a Live connection run to carry its original mode and generation', async () => {
    const connectionId = `mode-connection-${kit.fx.ids.token(4)}`;
    await run(
      kit.env.DB,
      `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
       VALUES (?, ?, 'demo', 'mode', 1, 1, 1)`,
      [connectionId, kit.org.id],
    );
    const input = {
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: kit.template.version,
      input: { memberName: 'Synced' },
      connectionId,
      connectionGeneration: 1,
      externalRef: 'mode-ref',
      source: 'connection' as const,
      actor: { type: 'system' as const, id: null },
    };
    await expect(createPassRow(kit.ctx, { ...input, mode: 'test' })).rejects.toMatchObject({
      code: 'MODE_MISMATCH',
    });
    await expect(
      createPassRow(kit.ctx, { ...input, mode: 'live', connectionGeneration: 0 }),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect((await createPassRow(kit.ctx, { ...input, mode: 'live' })).mode).toBe('live');
  });
  it('rejects a Test review after a switch to Live without issuing or sending', async () => {
    const before = kit.mailer.sent.length;
    const response = await api('/passes', {
      method: 'POST',
      headers: { ...fake.admin(), 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: kit.org.id,
        templateId: kit.template.id,
        templateVersion: kit.template.version,
        mode: 'test',
        input: { memberName: 'Stale reviewed Test' },
        holderEmail: 'stale-review@example.com',
        sendEmail: true,
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'MODE_MISMATCH' });
    expect(
      await first(kit.env.DB, "SELECT id FROM passes WHERE display_title = 'Stale reviewed Test'"),
    ).toBeNull();
    expect(kit.mailer.sent).toHaveLength(before);
  });
});

describe('issuance review isolation', () => {
  it('rejects a Test review bound to a Live connector without writing an artifact', async () => {
    const connectionId = `live-connection-${kit.fx.ids.token(4)}`;
    const passId = `test-review-${kit.fx.ids.token(4)}`;
    await run(
      kit.env.DB,
      `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
       VALUES (?, ?, 'demo', 'live', 1, 1, 1)`,
      [connectionId, kit.org.id],
    );
    for (const selected of [connectionId, 'missing-connection']) {
      await expect(
        createPassRow(kit.ctx, {
          passId,
          orgId: kit.org.id,
          templateId: kit.template.id,
          templateVersion: kit.template.version,
          mode: 'test',
          input: { memberName: 'Must not receive live data' },
          connectionId: selected,
          externalRef: 'live-ref',
          source: 'manual',
          actor: { type: 'user', id: 'admin-1' },
        }),
      ).rejects.toMatchObject({ code: 'MODE_MISMATCH' });
    }
    expect(await getPass(kit.env.DB, passId)).toBeNull();
    expect((await kit.env.BUCKET.list({ prefix: `passes/${passId}/` })).objects).toHaveLength(0);
  });

  it('does not expose a quarantined pre-cutover Test pass through pass reads or lists', async () => {
    const pass = await createPassRow(kit.ctx, {
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: kit.template.version,
      mode: 'test',
      input: { memberName: 'Legacy Test' },
      source: 'manual',
      actor: { type: 'system', id: null },
    });
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    const headers = fake.admin({ mode: 'test' });
    expect(await getPass(kit.env.DB, pass.id)).toBeNull();
    expect((await api(`/passes/${pass.id}`, { headers })).status).toBe(404);
    const page = PassListSchema.parse(await (await api('/passes', { headers })).json());
    expect(page.items.some((item) => item.id === pass.id)).toBe(false);
  });

  it('issues and captures a matching Test review without a Live email', async () => {
    const before = kit.mailer.sent.length;
    const response = await api('/passes', {
      method: 'POST',
      headers: { ...fake.admin({ mode: 'test' }), 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: kit.org.id,
        templateId: kit.template.id,
        templateVersion: kit.template.version,
        mode: 'test',
        input: { memberName: 'Reviewed Test' },
        holderEmail: 'reviewed-test@example.com',
        sendEmail: true,
      }),
    });
    expect(response.status).toBe(201);
    const detail = PassDetailSchema.parse(await response.json());
    expect(detail.mode).toBe('test');
    expect(
      await first(kit.env.DB, 'SELECT test_data_quarantined FROM passes WHERE id = ?', [detail.id]),
    ).toEqual({ test_data_quarantined: 0 });
    const outbox = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'",
      [detail.id],
    );
    expect(outbox).not.toBeNull();
    await handleEmailSend({ kind: 'email.send', outboxId: outbox?.id ?? '' }, kit.ctx);
    expect(kit.mailer.sent).toHaveLength(before);
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM captured_emails WHERE outbox_id = ?', [
        outbox?.id ?? '',
      ]),
    ).toEqual({ pass_id: detail.id });
  });

  it('requires both reviewed mode and template version at the API boundary', async () => {
    for (const body of [
      { orgId: kit.org.id, templateId: kit.template.id, templateVersion: kit.template.version },
      { orgId: kit.org.id, templateId: kit.template.id, mode: 'live' },
    ]) {
      const response = await api('/passes', {
        method: 'POST',
        headers: { ...fake.admin(), 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, input: { memberName: 'Unreviewed' } }),
      });
      expect(response.status).toBe(422);
    }
    expect(
      await first(kit.env.DB, "SELECT id FROM passes WHERE display_title = 'Unreviewed'"),
    ).toBeNull();
  });

  it('fails closed if an internal create loses its reviewed context', async () => {
    const passId = `missing-review-${kit.fx.ids.token(4)}`;
    const input = {
      passId,
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: kit.template.version,
      mode: 'test' as const,
      input: { memberName: 'Missing review' },
      source: 'manual' as const,
      actor: { type: 'system' as const, id: null },
    };
    for (const params of [
      { ...input, mode: undefined },
      { ...input, templateVersion: undefined },
    ]) {
      await expect(
        createPassRow(kit.ctx, params as unknown as CreateParams),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(await getPass(kit.env.DB, passId)).toBeNull();
    expect((await kit.env.BUCKET.list({ prefix: `passes/${passId}/` })).objects).toHaveLength(0);
  });

  it('rejects a reviewed revision which is no longer active', async () => {
    await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
      'new-revision',
      kit.template.id,
    ]);
    try {
      const response = await create(fake.admin());
      expect(response.status).toBe(412);
      expect(await response.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
    } finally {
      await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
        kit.template.version,
        kit.template.id,
      ]);
    }
  });

  it.each([
    'template-version',
    'template-owner',
    'template-archived',
    'connection-generation',
    'connection-owner',
    'connection-disabled',
    'organization',
  ] as const)(
    'fences a %s change between R2 storage and the D1 insert',
    async (changed) => {
      const passId = `create-race-${kit.fx.ids.token(4)}`;
      const connectionId = `create-race-connection-${kit.fx.ids.token(4)}`;
      await run(
        kit.env.DB,
        `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
         VALUES (?, ?, 'demo', 'race', 1, 1, 1)`,
        [connectionId, kit.org.id],
      );
      const put = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, value, options) => {
        const object = await put(key, value, options);
        if (key.startsWith(`passes/${passId}/`)) {
          if (changed === 'template-version')
            await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
              'new-revision',
              kit.template.id,
            ]);
          else if (changed === 'template-owner')
            await run(kit.env.DB, 'UPDATE templates SET org_id = ? WHERE id = ?', [
              otherOrg.id,
              kit.template.id,
            ]);
          else if (changed === 'template-archived')
            await run(kit.env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [
              kit.template.id,
            ]);
          else if (changed === 'connection-generation')
            await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
              connectionId,
            ]);
          else if (changed === 'connection-owner')
            await run(kit.env.DB, 'UPDATE connections SET org_id = ? WHERE id = ?', [
              otherOrg.id,
              connectionId,
            ]);
          else if (changed === 'connection-disabled')
            await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [connectionId]);
          else
            await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
        }
        return object;
      });
      try {
        await expect(
          createPassRow(kit.ctx, {
            passId,
            orgId: kit.org.id,
            templateId: kit.template.id,
            templateVersion: kit.template.version,
            mode: 'live',
            input: { memberName: 'Fenced' },
            connectionId,
            externalRef: 'race-ref',
            source: 'manual',
            actor: { type: 'user', id: 'admin-1' },
          }),
        ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
        expect(await getPass(kit.env.DB, passId)).toBeNull();
        expect((await kit.env.BUCKET.list({ prefix: `passes/${passId}/` })).objects).toHaveLength(0);
      } finally {
        spy.mockRestore();
        await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
          kit.template.version,
          kit.template.id,
        ]);
        await run(kit.env.DB, 'UPDATE templates SET org_id = NULL WHERE id = ?', [kit.template.id]);
        await run(kit.env.DB, "UPDATE templates SET status = 'active' WHERE id = ?", [kit.template.id]);
        await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
      }
    },
  );
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
      templateVersion: kit.template.version,
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
        templateVersion: kit.template.version,
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
      templateVersion: kit.template.version,
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
      expected: pass,
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
      expected: pass,
    });
    await handleEmailSend({ kind: 'email.send', outboxId }, kit.ctx);
    expect(kit.mailer.sent).toHaveLength(before + 1);
  });
});
