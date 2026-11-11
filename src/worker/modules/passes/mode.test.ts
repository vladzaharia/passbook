import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeOrg, makeUser, persistTemplate } from '../../../../test/helpers/index.ts';
import { PassDetailSchema, PassListSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { listMyPasses } from '../me/service.ts';
import { getOverview } from '../metrics/service.ts';
import { activeRelease, type TemplateRelease } from '../templates/releases.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { createPassRow } from './create.ts';
import type { CreateParams, PassIssuanceExecution } from './create-types.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { tenantAuthorityOf } from './http.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let auth: TenantTestAuth;
let kit: Kit;
let app: ReturnType<typeof createApp>;
let otherOrg: { id: string };
let liveRelease: TemplateRelease;
let testRelease: TemplateRelease;
let otherTestRelease: TemplateRelease;
let adminUserId: string;
let tenantExecutions: Record<'live' | 'test', Extract<PassIssuanceExecution, { kind: 'tenant' }>>;

beforeAll(async () => {
  kit = await setupKit();
  const live = await activeRelease(kit.ctx, kit.template.id, kit.org.id, 'live', 'apple');
  const test = await activeRelease(kit.ctx, kit.template.id, kit.org.id, 'test', 'apple');
  if (!live || !test) throw new Error('Default releases missing');
  liveRelease = live;
  testRelease = test;
  auth = await setupTenantTestAuth(kit);
  const cookie = auth.admin().cookie?.split('=')[1];
  const session = cookie ? await auth.stores.sessions.resolve(cookie) : null;
  if (!session) throw new Error('Admin session missing');
  adminUserId = session.userId;
  tenantExecutions = {
    live: {
      kind: 'tenant',
      authority: await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'passes:operate'),
    },
    test: {
      kind: 'tenant',
      authority: await tenantAuthorityOf(
        kit.ctx,
        { ...session, mode: 'test' },
        kit.org.id,
        'passes:operate',
      ),
    },
  };
  app = createApp({ stores: auth.stores, clock: kit.clock });
  otherOrg = await makeOrg(kit.fx, { name: 'Other Org' });
  otherTestRelease = await approveAppleRelease(kit, { orgId: otherOrg.id, mode: 'test' });
  await auth.addOrg(otherOrg.id);
}, 60_000);

type Headers = Record<string, string>;
const api = (path: string, init: RequestInit & { headers?: Headers } = {}) =>
  app.request(`${ORIGIN}/api/v1${path}`, init, kit.env);
const review = (release: TemplateRelease) => ({
  templateVersion: release.version,
  releaseId: release.id,
  releaseGeneration: release.generation,
});
const reviewedRelease = (orgId: string, mode: 'live' | 'test') => {
  if (orgId === kit.org.id) return mode === 'live' ? liveRelease : testRelease;
  if (orgId === otherOrg.id && mode === 'test') return otherTestRelease;
  throw new Error(`No ${mode} release fixture for ${orgId}`);
};
const create = (
  headers: Headers,
  orgId = kit.org.id,
  reviewedMode: 'live' | 'test' = !headers.authorization && headers['x-passbook-mode'] === 'test'
    ? 'test'
    : 'live',
  overrides: Record<string, unknown> = {},
) =>
  api('/passes', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      orgId,
      templateId: kit.template.id,
      ...review(reviewedRelease(orgId, reviewedMode)),
      mode: reviewedMode,
      input: { memberName: 'Mode Test' },
      ...overrides,
    }),
  });
const list = async (headers: Headers, orgId = kit.org.id) =>
  PassListSchema.parse(
    await (await api(`/passes?limit=200&orgId=${encodeURIComponent(orgId)}`, { headers })).json(),
  ).items;

describe('a pass takes the creator mode', () => {
  it('admin sessions follow x-passbook-mode; anything but test is live', async () => {
    const live = PassDetailSchema.parse(await (await create(auth.admin())).json());
    const test = PassDetailSchema.parse(await (await create(auth.admin({ mode: 'test' }))).json());
    const odd = PassDetailSchema.parse(
      await (await create({ ...auth.admin(), 'x-passbook-mode': 'TESTING' })).json(),
    );
    expect([live.mode, test.mode, odd.mode]).toEqual(['live', 'test', 'live']);
    expect(await getPass(kit.env.DB, test.id)).toMatchObject({
      mode: 'test',
      templateVersion: testRelease.version,
      releaseId: testRelease.id,
    });
    expect((await getPass(kit.env.DB, live.id))?.releaseId).toBe(liveRelease.id);
  });

  it('API keys follow api_keys.mode and ignore the header', async () => {
    const testKey = await auth.apiKey({ orgId: null, mode: 'test' });
    const liveKey = await auth.apiKey({ orgId: null });
    const fromTest = PassDetailSchema.parse(
      await (await create(testKey, kit.org.id, 'test')).json(),
    );
    const fromLive = PassDetailSchema.parse(
      await (await create({ ...liveKey, 'x-passbook-mode': 'test' })).json(),
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
    const credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    const input = {
      orgId: kit.org.id,
      templateId: kit.template.id,
      input: { memberName: 'Synced' },
      connectionId,
      connectionGeneration: 1,
      credentialKeysetCommitment,
      expectedConnectionMode: 'poll' as const,
      externalRef: 'mode-ref',
      source: 'connection' as const,
      execution: { kind: 'connection' as const, connectionId, generation: 1 },
      actor: { type: 'system' as const, id: null },
    };
    await expect(
      createPassRow(jobCtxOf(kit), { ...input, ...review(testRelease), mode: 'test' }),
    ).rejects.toMatchObject({
      code: 'MODE_MISMATCH',
    });
    await expect(
      createPassRow(jobCtxOf(kit), {
        ...input,
        ...review(liveRelease),
        mode: 'live',
        connectionGeneration: 2,
        execution: { kind: 'connection', connectionId, generation: 2 },
      }),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    const created = await createPassRow(jobCtxOf(kit), {
      ...input,
      ...review(liveRelease),
      mode: 'live',
    });
    expect(created.mode).toBe('live');
  });
  it('rejects a Test review after a switch to Live without issuing or sending', async () => {
    const before = kit.mailer.sent.length;
    const response = await api('/passes', {
      method: 'POST',
      headers: { ...auth.admin(), 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: kit.org.id,
        templateId: kit.template.id,
        ...review(testRelease),
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
        createPassRow(jobCtxOf(kit), {
          passId,
          orgId: kit.org.id,
          templateId: kit.template.id,
          ...review(testRelease),
          mode: 'test',
          input: { memberName: 'Must not receive live data' },
          connectionId: selected,
          externalRef: 'live-ref',
          source: 'manual',
          execution: tenantExecutions.test,
          actor: { type: 'user', id: adminUserId },
        }),
      ).rejects.toMatchObject({ code: 'MODE_MISMATCH' });
    }
    expect(await getPass(kit.env.DB, passId)).toBeNull();
    expect((await kit.env.BUCKET.list({ prefix: `passes/${passId}/` })).objects).toHaveLength(0);
  });

  it('does not expose a quarantined pre-cutover Test pass through pass reads or lists', async () => {
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: kit.template.id,
      ...review(testRelease),
      mode: 'test',
      input: { memberName: 'Legacy Test' },
      source: 'manual',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    const headers = auth.admin({ mode: 'test' });
    expect(await getPass(kit.env.DB, pass.id)).toBeNull();
    expect((await api(`/passes/${pass.id}`, { headers })).status).toBe(404);
    const page = PassListSchema.parse(
      await (await api(`/passes?orgId=${encodeURIComponent(kit.org.id)}`, { headers })).json(),
    );
    expect(page.items.some((item) => item.id === pass.id)).toBe(false);
  });

  it('issues and captures a matching Test review without a Live email', async () => {
    const before = kit.mailer.sent.length;
    const response = await api('/passes', {
      method: 'POST',
      headers: { ...auth.admin({ mode: 'test' }), 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: kit.org.id,
        templateId: kit.template.id,
        ...review(testRelease),
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

  it('requires the reviewed mode, version and release at the API boundary', async () => {
    const body = {
      orgId: kit.org.id,
      templateId: kit.template.id,
      ...review(liveRelease),
      mode: 'live',
      input: { memberName: 'Unreviewed' },
    };
    for (const patch of [
      { mode: undefined },
      { templateVersion: undefined },
      { releaseId: undefined },
      { releaseGeneration: undefined },
    ]) {
      const response = await api('/passes', {
        method: 'POST',
        headers: { ...auth.admin(), 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, ...patch }),
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
      ...review(testRelease),
      mode: 'test' as const,
      input: { memberName: 'Missing review' },
      source: 'manual' as const,
      execution: tenantExecutions.test,
      actor: { type: 'user' as const, id: adminUserId },
    };
    for (const [params, code] of [
      [{ ...input, mode: undefined }, 'FORBIDDEN'],
      [{ ...input, templateVersion: undefined }, 'VALIDATION'],
      [{ ...input, releaseId: undefined }, 'TEMPLATE_RELEASE_CONFLICT'],
      [{ ...input, releaseGeneration: undefined }, 'TEMPLATE_RELEASE_CONFLICT'],
      [
        { ...input, releaseId: undefined, releaseGeneration: undefined },
        'TEMPLATE_RELEASE_CONFLICT',
      ],
    ] as const) {
      await expect(
        createPassRow(jobCtxOf(kit), params as unknown as CreateParams),
      ).rejects.toMatchObject({ code });
    }
    expect(await getPass(kit.env.DB, passId)).toBeNull();
    expect((await kit.env.BUCKET.list({ prefix: `passes/${passId}/` })).objects).toHaveLength(0);
  });

  it('issues the approved release, not an unapproved active draft', async () => {
    const icon = new Uint8Array(
      await new Response(await kit.registry.openAsset(kit.template, 'icon.png')).arrayBuffer(),
    );
    const source = {
      id: kit.template.id,
      orgId: kit.template.orgId,
      origin: kit.template.origin,
      manifest: kit.template.manifest,
      passJson: kit.template.passJson,
      assets: { 'icon.png': icon },
    };
    const draft = kit.registry.add({ ...source, version: 'new-revision' });
    kit.registry.add({ ...source, version: kit.template.version });
    await persistTemplate(kit.fx, draft, { registry: kit.registry });
    await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
      draft.version,
      kit.template.id,
    ]);
    try {
      const approved = await create(auth.admin());
      expect(approved.status).toBe(201);
      const pass = PassDetailSchema.parse(await approved.json());
      expect(pass.templateVersion).toBe(liveRelease.version);
      expect((await getPass(kit.env.DB, pass.id))?.releaseId).toBe(liveRelease.id);

      const unapproved = await create(auth.admin(), kit.org.id, 'live', {
        templateVersion: draft.version,
        input: { memberName: 'Unreviewed active revision' },
      });
      expect(unapproved.status).toBe(409);
      expect(await unapproved.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
      expect(
        await first(
          kit.env.DB,
          "SELECT id FROM passes WHERE display_title = 'Unreviewed active revision'",
        ),
      ).toBeNull();
    } finally {
      await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
        kit.template.version,
        kit.template.id,
      ]);
    }
  });

  it.each([
    'release',
    'template-owner',
    'template-archived',
    'connection-generation',
    'connection-owner',
    'connection-disabled',
    'organization',
  ] as const)('fences a %s change between R2 storage and the D1 insert', async (changed) => {
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
        if (changed === 'release')
          liveRelease = await approveAppleRelease(kit, { orgId: kit.org.id, mode: 'live' });
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
        createPassRow(jobCtxOf(kit), {
          passId,
          orgId: kit.org.id,
          templateId: kit.template.id,
          ...review(liveRelease),
          mode: 'live',
          input: { memberName: 'Fenced' },
          connectionId,
          externalRef: 'race-ref',
          source: 'manual',
          execution: tenantExecutions.live,
          actor: { type: 'user', id: adminUserId },
        }),
      ).rejects.toMatchObject({
        code:
          changed === 'release' || changed === 'template-owner' || changed === 'template-archived'
            ? 'TEMPLATE_RELEASE_CONFLICT'
            : changed === 'organization'
              ? 'ORG_ACCESS_CHANGED'
              : 'PASS_CONFLICT',
      });
      expect(await getPass(kit.env.DB, passId)).toBeNull();
      expect((await kit.env.BUCKET.list({ prefix: `passes/${passId}/` })).objects).toHaveLength(0);
    } finally {
      spy.mockRestore();
      await run(kit.env.DB, 'UPDATE templates SET org_id = NULL WHERE id = ?', [kit.template.id]);
      await run(kit.env.DB, "UPDATE templates SET status = 'active' WHERE id = ?", [
        kit.template.id,
      ]);
      await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    }
  });
});

describe('lists filter by the caller mode; get by id works in both', () => {
  it('splits live and test for admins and keys, inside tenant scope', async () => {
    const live = PassDetailSchema.parse(await (await create(auth.admin())).json());
    const test = PassDetailSchema.parse(await (await create(auth.admin({ mode: 'test' }))).json());
    const otherTest = PassDetailSchema.parse(
      await (await create(auth.admin({ mode: 'test' }), otherOrg.id)).json(),
    );
    expect((await getPass(kit.env.DB, otherTest.id))?.releaseId).toBe(otherTestRelease.id);
    const ids = (items: { id: string }[]) => items.map((p) => p.id);

    const adminLive = ids(await list(auth.admin()));
    expect(adminLive).toContain(live.id);
    expect(adminLive).not.toContain(test.id);
    const adminTest = ids(await list(auth.admin({ mode: 'test' })));
    expect(adminTest).toContain(test.id);
    expect(adminTest).not.toContain(live.id);
    expect(adminTest).not.toContain(otherTest.id);
    const otherAdminTest = ids(await list(auth.admin({ mode: 'test' }), otherOrg.id));
    expect(otherAdminTest).toContain(otherTest.id);
    expect(otherAdminTest).not.toContain(test.id);

    const keyTest = ids(await list(await auth.apiKey({ mode: 'test', orgId: kit.org.id })));
    expect(keyTest).toContain(test.id);
    expect(keyTest).not.toContain(otherTest.id);
    expect(keyTest).not.toContain(live.id);
    const keyLive = ids(await list(await auth.apiKey({ orgId: kit.org.id })));
    expect(keyLive).toContain(live.id);
    expect(keyLive).not.toContain(test.id);

    // Sessions read either mode by id; a key reads only its own.
    for (const headers of [
      auth.admin(),
      auth.admin({ mode: 'test' }),
      await auth.apiKey({ orgId: null, mode: 'test' }),
    ]) {
      const got = PassDetailSchema.parse(
        await (await api(`/passes/${test.id}`, { headers })).json(),
      );
      expect(got.mode).toBe('test');
    }
    const liveKey = await auth.apiKey({ orgId: null, mode: 'live' });
    expect((await api(`/passes/${test.id}`, { headers: liveKey })).status).toBe(404);
    // A key of another org cannot read it in either mode.
    expect(
      (
        await api(`/passes/${test.id}`, {
          headers: await auth.apiKey({ orgId: otherOrg.id, mode: 'test' }),
        })
      ).status,
    ).toBe(404);
  });
});

describe('holders and metrics', () => {
  it('a holder sees test and live passes together', async () => {
    const user = await makeUser(kit.fx);
    const live = await kit.pass({ holderEmail: user.primaryEmail });
    const test = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: kit.template.id,
      ...review(testRelease),
      input: { memberName: 'Holder Test' },
      holderEmail: user.primaryEmail,
      source: 'manual',
      mode: 'test',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    expect(live.ownerUserId).toBe(user.id);
    expect(test.ownerUserId).toBe(user.id);
    const mine = await listMyPasses(kit.ctx, user.id, { limit: 50 });
    expect(mine.items.map((p) => p.id).sort()).toEqual([live.id, test.id].sort());
    expect(mine.items.find((p) => p.id === test.id)?.mode).toBe('test');
  });

  it('overview totals count only the caller mode', async () => {
    const org = await makeOrg(kit.fx, { name: 'Metrics Org' });
    const releases = {
      live: await approveAppleRelease(kit, { orgId: org.id, mode: 'live' }),
      test: await approveAppleRelease(kit, { orgId: org.id, mode: 'test' }),
    };
    const make = (mode: 'live' | 'test') =>
      createPassRow(jobCtxOf(kit), {
        orgId: org.id,
        templateId: kit.template.id,
        ...review(releases[mode]),
        input: { memberName: `M ${mode}` },
        source: 'manual',
        mode,
        execution: { kind: 'system' },
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
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: kit.template.id,
      ...review(testRelease),
      input: { memberName: 'Mail Test' },
      source: 'manual',
      mode: 'test',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    const before = kit.mailer.sent.length;
    const { outboxId } = await enqueuePassEmail(jobCtxOf(kit), {
      passId: pass.id,
      to: 'holder-test-mode@example.com',
      attach: false,
      expected: pass,
    });
    await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
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
    const { outboxId } = await enqueuePassEmail(jobCtxOf(kit), {
      passId: pass.id,
      to: 'holder-live-mode@example.com',
      attach: false,
      expected: pass,
    });
    await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
    expect(kit.mailer.sent).toHaveLength(before + 1);
  });
});
