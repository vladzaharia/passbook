import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApiKey, makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { BundleSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { eventMember, eventStores } from '../events/test-auth-fixtures.ts';
import { reassignHolder } from '../holders/service.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { createBundle } from './service.ts';

const job = () => jobCtxOf(kit);

const origin = 'https://wallet.test';
let kit: Kit;
let app: OpenAPIHono<AppBindings>;
beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: eventStores(kit), clock: kit.clock });
});

const call = async (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> =>
  app.request(
    `${origin}/api/v1/bundles${path}`,
    {
      method,
      headers: {
        ...headers,
        origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );

async function create(
  headers: Record<string, string>,
  passId: string,
  name: string,
  orgId = kit.org.id,
) {
  const response = await call('POST', '', headers, {
    orgId,
    name,
    passIds: [passId],
    holderEmail: `${name.toLowerCase().replaceAll(' ', '-')}@example.test`,
  });
  expect(response.status).toBe(201);
  return BundleSchema.parse(await response.json());
}

async function mailEffects(passId: string, bundleId: string) {
  const db = kit.env.DB;
  return {
    counters: await all(
      db,
      "SELECT key, window_start, count FROM counters WHERE key LIKE 'pass-email:%' ORDER BY key, window_start",
    ),
    outbox: await all(db, "SELECT id FROM outbox WHERE json_extract(payload, '$.bundleId') = ?", [
      bundleId,
    ]),
    events: await all(
      db,
      "SELECT id FROM pass_events WHERE pass_id = ? AND kind = 'email.queued'",
      [passId],
    ),
    audit: await all(
      db,
      "SELECT id FROM audit_log WHERE target_id = ? AND action = 'bundle.send_email'",
      [bundleId],
    ),
  };
}

/** Run a revocation after preflight, immediately before D1's atomic batch. */
async function raceBatch(mutate: () => Promise<unknown>, operation: () => Promise<Response>) {
  const db = kit.env.DB;
  const batch = db.batch.bind(db);
  const spy = vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
    await mutate();
    return batch(statements);
  });
  try {
    return await operation();
  } finally {
    spy.mockRestore();
  }
}

describe('bundle tenant authorization', () => {
  it('requires explicit organization and actual membership even for a platform admin', async () => {
    const user = await makeUser(kit.fx);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
    const pass = await kit.pass();
    const bundle = await create(operator.session.headers, pass.id, 'Member bundle');
    expect((await call('GET', '', session.headers)).status).toBe(422);
    expect((await call('GET', `?orgId=${kit.org.id}`, session.headers)).status).toBe(403);
    expect(
      (
        await call('POST', '', session.headers, {
          orgId: kit.org.id,
          name: 'No grant',
          passIds: [pass.id],
        })
      ).status,
    ).toBe(403);
    expect((await call('GET', `/${bundle.id}`, session.headers)).status).toBe(404);
    expect((await call('DELETE', `/${bundle.id}`, session.headers)).status).toBe(404);
  });

  it('fails closed when a bundle write has no valid execution provenance', async () => {
    const pass = await kit.pass();
    const input = { orgId: kit.org.id, name: 'Missing provenance', passIds: [pass.id] };
    const actor = { type: 'user', id: 'untrusted' } as const;
    await expect(
      createBundle(job(), actor, 'live', input, undefined as never),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createBundle(job(), actor, 'live', input, { kind: 'tenant' } as never),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await all(kit.env.DB, "SELECT id FROM bundles WHERE name = 'Missing provenance'"),
    ).toHaveLength(0);
  });

  it('enforces read and operate grants and masks another tenant', async () => {
    const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
    const reader = await eventMember(kit, kit.org.id, ['read_only']);
    const operatorSession = await makeSession(kit.fx, {
      userId: operator.user.id,
      roles: ['user'],
    });
    const readerSession = await makeSession(kit.fx, { userId: reader.user.id, roles: ['user'] });
    const foreignOrg = await makeOrg(kit.fx);
    const foreign = await eventMember(kit, foreignOrg.id, ['pass_operator']);
    const pass = await kit.pass();
    const bundle = await create(operatorSession.headers, pass.id, 'Tenant bundle');
    expect((await call('GET', `?orgId=${kit.org.id}`, readerSession.headers)).status).toBe(200);
    expect((await call('GET', `/${bundle.id}`, readerSession.headers)).status).toBe(200);
    expect(
      (await call('POST', `/${bundle.id}/rotate-link`, readerSession.headers, {})).status,
    ).toBe(403);
    expect((await call('POST', `/${bundle.id}/send-email`, readerSession.headers, {})).status).toBe(
      403,
    );
    expect((await call('GET', `/${bundle.id}`, foreign.session.headers)).status).toBe(404);
    expect((await call('DELETE', `/${bundle.id}`, foreign.session.headers)).status).toBe(404);
    expect((await call('GET', `/${bundle.id}`, operatorSession.headers)).status).toBe(200);
    const foreignKey = await makeApiKey(kit.fx, { orgId: foreignOrg.id });
    expect((await call('GET', `/${bundle.id}`, foreignKey.headers)).status).toBe(404);
    expect((await call('GET', `?orgId=${kit.org.id}`, foreignKey.headers)).status).toBe(403);
  });

  it('rejects a foreign pass before inserting the bundle, members, audit or email', async () => {
    const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
    const foreignOrg = await makeOrg(kit.fx);
    const foreignPass = await kit.pass({ orgId: foreignOrg.id });
    const mine = await kit.pass();
    const response = await call('POST', '', operator.session.headers, {
      orgId: kit.org.id,
      name: 'Foreign pass',
      passIds: [mine.id, foreignPass.id],
      holderEmail: 'foreign@example.test',
      sendEmail: true,
    });
    expect(response.status).toBe(404);
    expect(
      await all(kit.env.DB, "SELECT id FROM bundles WHERE name = 'Foreign pass'"),
    ).toHaveLength(0);
    expect(
      await all(kit.env.DB, 'SELECT bundle_id FROM bundle_passes WHERE pass_id IN (?, ?)', [
        mine.id,
        foreignPass.id,
      ]),
    ).toHaveLength(0);
    expect(
      await all(
        kit.env.DB,
        "SELECT id FROM audit_log WHERE actor_id = ? AND action = 'bundle.create'",
        [operator.user.id],
      ),
    ).toHaveLength(0);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id IN (?, ?) AND kind = 'email'", [
        mine.id,
        foreignPass.id,
      ]),
    ).toHaveLength(0);
  });

  it('rolls back all bundle rows if a selected pass changes before creation commits', async () => {
    const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
    const pass = await kit.pass();
    const response = await raceBatch(
      () =>
        run(kit.env.DB, 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?', [
          pass.id,
        ]),
      () =>
        call('POST', '', operator.session.headers, {
          orgId: kit.org.id,
          name: 'Stale pass race',
          passIds: [pass.id],
          holderEmail: 'stale-pass@example.test',
          sendEmail: true,
        }),
    );
    expect(response.status).toBe(409);
    expect(
      await all(kit.env.DB, "SELECT id FROM bundles WHERE name = 'Stale pass race'"),
    ).toHaveLength(0);
    expect(
      await all(kit.env.DB, 'SELECT bundle_id FROM bundle_passes WHERE pass_id = ?', [pass.id]),
    ).toHaveLength(0);
    expect(
      await all(
        kit.env.DB,
        "SELECT id FROM audit_log WHERE actor_id = ? AND action = 'bundle.create'",
        [operator.user.id],
      ),
    ).toHaveLength(0);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'", [
        pass.id,
      ]),
    ).toHaveLength(0);
  });

  it('does not create a bundle, membership, audit or email after membership revocation at commit', async () => {
    const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
    const pass = await kit.pass();
    const response = await raceBatch(
      () =>
        run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
          kit.clock.now(),
          operator.membership,
        ]),
      () =>
        call('POST', '', operator.session.headers, {
          orgId: kit.org.id,
          name: 'Revoked creation',
          passIds: [pass.id],
          holderEmail: 'race@example.test',
          sendEmail: true,
        }),
    );
    expect(response.status).not.toBe(201);
    expect(
      await all(kit.env.DB, "SELECT id FROM bundles WHERE name = 'Revoked creation'"),
    ).toHaveLength(0);
    expect(
      await all(kit.env.DB, 'SELECT bundle_id FROM bundle_passes WHERE pass_id = ?', [pass.id]),
    ).toHaveLength(0);
    expect(
      await all(
        kit.env.DB,
        "SELECT id FROM audit_log WHERE actor_id = ? AND action = 'bundle.create'",
        [operator.user.id],
      ),
    ).toHaveLength(0);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'", [
        pass.id,
      ]),
    ).toHaveLength(0);
  });

  it('does not rotate or audit if membership is revoked at commit', async () => {
    const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
    const pass = await kit.pass();
    const bundle = await create(operator.session.headers, pass.id, 'Rotation race');
    const response = await raceBatch(
      () =>
        run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
          kit.clock.now(),
          operator.membership,
        ]),
      () => call('POST', `/${bundle.id}/rotate-link`, operator.session.headers, {}),
    );
    expect(response.status).not.toBe(200);
    const row = await first<{ token: string }>(
      kit.env.DB,
      'SELECT token FROM bundles WHERE id = ?',
      [bundle.id],
    );
    expect(bundle.url.endsWith(`/b/${row?.token}`)).toBe(true);
    expect(
      await all(
        kit.env.DB,
        "SELECT id FROM audit_log WHERE target_id = ? AND action = 'bundle.rotate_link'",
        [bundle.id],
      ),
    ).toHaveLength(0);
  });

  it('does not delete or audit if the API key is revoked at commit', async () => {
    const key = await makeApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['passes:read', 'passes:write'],
    });
    const pass = await kit.pass();
    const bundle = await create(key.headers, pass.id, 'Key race');
    const response = await raceBatch(
      () =>
        run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
          kit.clock.now(),
          key.id,
        ]),
      () => call('DELETE', `/${bundle.id}`, key.headers),
    );
    expect(response.status).not.toBe(200);
    expect(
      await first(kit.env.DB, 'SELECT id FROM bundles WHERE id = ?', [bundle.id]),
    ).not.toBeNull();
    expect(
      await all(
        kit.env.DB,
        "SELECT id FROM audit_log WHERE target_id = ? AND action = 'bundle.delete'",
        [bundle.id],
      ),
    ).toHaveLength(0);
  });

  it('rechecks organization status at the mutation commit', async () => {
    const org = await makeOrg(kit.fx);
    const operator = await eventMember(kit, org.id, ['pass_operator']);
    const pass = await kit.pass({ orgId: org.id });
    const bundle = await create(operator.session.headers, pass.id, 'Org race', org.id);
    const response = await raceBatch(
      () =>
        run(
          kit.env.DB,
          "UPDATE orgs SET status = 'suspended', updated_at = updated_at + 1 WHERE id = ?",
          [org.id],
        ),
      () => call('DELETE', `/${bundle.id}`, operator.session.headers),
    );
    expect(response.status).not.toBe(200);
    expect(
      await first(kit.env.DB, 'SELECT id FROM bundles WHERE id = ?', [bundle.id]),
    ).not.toBeNull();
    expect(
      await all(
        kit.env.DB,
        "SELECT id FROM audit_log WHERE target_id = ? AND action = 'bundle.delete'",
        [bundle.id],
      ),
    ).toHaveLength(0);
  });

  it('does not enqueue, count, emit or audit when the session is revoked at the outbox batch', async () => {
    const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
    const pass = await kit.pass();
    const bundle = await create(operator.session.headers, pass.id, 'Mail race');
    const before = await mailEffects(pass.id, bundle.id);
    const response = await raceBatch(
      () =>
        run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [
          kit.clock.now(),
          operator.user.id,
        ]),
      () => call('POST', `/${bundle.id}/send-email`, operator.session.headers, {}),
    );
    expect(response.status).not.toBe(202);
    expect(await mailEffects(pass.id, bundle.id)).toEqual(before);
  });

  it('does not enqueue or audit when an API key loses its write scope at commit', async () => {
    const key = await makeApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['passes:read', 'passes:write'],
    });
    const pass = await kit.pass();
    const bundle = await create(key.headers, pass.id, 'Key mail race');
    const before = await mailEffects(pass.id, bundle.id);
    const response = await raceBatch(
      () =>
        run(kit.env.DB, 'UPDATE api_keys SET scopes = \'["passes:read"]\' WHERE id = ?', [key.id]),
      () => call('POST', `/${bundle.id}/send-email`, key.headers, {}),
    );
    expect(response.status).not.toBe(202);
    expect(await mailEffects(pass.id, bundle.id)).toEqual(before);
  });

  it.each(['deleted', 'rotated'] as const)(
    'does not enqueue or audit when the bundle is %s at the outbox commit',
    async (change) => {
      const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
      const pass = await kit.pass();
      const bundle = await create(operator.session.headers, pass.id, `Bundle ${change} race`);
      const before = await mailEffects(pass.id, bundle.id);
      const response = await raceBatch(
        () =>
          change === 'deleted'
            ? run(kit.env.DB, 'DELETE FROM bundles WHERE id = ?', [bundle.id])
            : run(kit.env.DB, 'UPDATE bundles SET token = ? WHERE id = ?', [
                kit.ctx.ids.token(),
                bundle.id,
              ]),
        () => call('POST', `/${bundle.id}/send-email`, operator.session.headers, {}),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'DELIVERY_STALE' });
      expect(await mailEffects(pass.id, bundle.id)).toEqual(before);
    },
  );

  it('does not enqueue or audit after a later bundle member is reassigned at the outbox commit', async () => {
    const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
    const pass = await kit.pass({ holderEmail: 'previous-holder@example.test' });
    const later = await kit.pass({ holderEmail: 'previous-holder@example.test' });
    const created = await call('POST', '', operator.session.headers, {
      orgId: kit.org.id,
      name: 'Holder mail race',
      passIds: [pass.id, later.id],
      holderEmail: 'bundle-holder@example.test',
    });
    expect(created.status).toBe(201);
    const bundle = BundleSchema.parse(await created.json());
    const before = await mailEffects(pass.id, bundle.id);
    const response = await raceBatch(
      () =>
        reassignHolder(
          jobCtxOf(kit),
          { type: 'system', id: null },
          { passId: later.id, email: 'new-holder@example.test' },
          null,
        ),
      () => call('POST', `/${bundle.id}/send-email`, operator.session.headers, {}),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'DELIVERY_STALE' });
    expect(await mailEffects(pass.id, bundle.id)).toEqual(before);
  });

  it('queues one email and one audit for an authorized send', async () => {
    const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
    const pass = await kit.pass();
    const bundle = await create(operator.session.headers, pass.id, 'Authorized mail');
    const response = await call('POST', `/${bundle.id}/send-email`, operator.session.headers, {});
    expect(response.status).toBe(202);
    const effects = await mailEffects(pass.id, bundle.id);
    expect(effects.outbox).toHaveLength(1);
    expect(effects.events).toHaveLength(1);
    expect(effects.audit).toHaveLength(1);
  });

  it('queues an authorized org-scoped API key send to the bundle holder', async () => {
    const key = await makeApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['passes:read', 'passes:write'],
    });
    const pass = await kit.pass();
    const bundle = await create(key.headers, pass.id, 'Authorized key mail');
    const response = await call('POST', `/${bundle.id}/send-email`, key.headers, {});
    expect(response.status).toBe(202);
    const effects = await mailEffects(pass.id, bundle.id);
    expect(effects.outbox).toHaveLength(1);
    expect(effects.events).toHaveLength(1);
    expect(effects.audit).toHaveLength(1);
  });

  it('keeps the created bundle but never sends when the session is revoked before create-time email', async () => {
    const operator = await eventMember(kit, kit.org.id, ['pass_operator']);
    const pass = await kit.pass();
    const db = kit.env.DB;
    const batch = db.batch.bind(db);
    let batches = 0;
    const spy = vi.spyOn(db, 'batch').mockImplementation(async (statements) => {
      if (++batches === 2)
        await run(db, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [
          kit.clock.now(),
          operator.user.id,
        ]);
      return batch(statements);
    });
    let response: Response;
    try {
      response = await call('POST', '', operator.session.headers, {
        orgId: kit.org.id,
        name: 'Create email race',
        passIds: [pass.id],
        holderEmail: 'create-email-race@example.test',
        sendEmail: true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(response.status).toBe(201);
    const bundle = BundleSchema.parse(await response.json());
    const effects = await mailEffects(pass.id, bundle.id);
    expect(effects.outbox).toHaveLength(0);
    expect(effects.events).toHaveLength(0);
    expect(effects.audit).toHaveLength(0);
    expect(
      await all(db, "SELECT id FROM audit_log WHERE target_id = ? AND action = 'bundle.create'", [
        bundle.id,
      ]),
    ).toHaveLength(1);
  });
});
