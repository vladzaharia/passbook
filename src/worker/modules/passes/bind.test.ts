import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { overrideDeps } from './deps.ts';
import { getPass } from './repo.ts';
import { type Kit, setupKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
});

type Headers = Record<string, string>;
const api = (path: string, init: RequestInit & { headers?: Headers } = {}) =>
  app.request(`${ORIGIN}/api/v1${path}`, init, kit.env);
const send = (
  method: string,
  headers: Headers,
  body: unknown,
): RequestInit & { headers: Headers } => ({
  method,
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function connection(orgId = kit.org.id) {
  const id = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
     VALUES (?, ?, 'demo', 'c', 1, 1, 1)`,
    [id, orgId],
  );
  return id;
}

describe('PUT /passes/:id/connection', () => {
  it('binds, takes over fields, queues a refresh and unbinds', async () => {
    const pass = await kit.pass();
    const connectionId = await connection();
    kit.queue.sent.length = 0;
    const res = await api(
      `/passes/${pass.id}/connection`,
      send('PUT', fake.admin(), { connectionId, externalRef: 'ref-1' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      connectionId,
      externalRef: 'ref-1',
      fieldSources: { memberName: 'connection' },
    });
    expect(kit.queue.sent).toContainEqual(expect.objectContaining({ kind: 'pass.refresh' }));
    const unbind = await api(
      `/passes/${pass.id}/connection`,
      send('PUT', fake.admin(), { connectionId: null, externalRef: null }),
    );
    expect(await unbind.json()).toMatchObject({ connectionId: null, externalRef: null });
    const actions = await first<{ n: number }>(
      kit.env.DB,
      "SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action IN ('pass.bind', 'pass.unbind')",
      [pass.id],
    );
    expect(actions?.n).toBe(2);
  });

  it('keeps existing field sources with resetFieldSources false', async () => {
    const pass = await kit.pass();
    const connectionId = await connection();
    const res = await api(
      `/passes/${pass.id}/connection`,
      send('PUT', fake.admin(), {
        connectionId,
        externalRef: 'ref-keep',
        resetFieldSources: false,
      }),
    );
    expect(await res.json()).toMatchObject({ fieldSources: { memberName: 'manual' } });
  });

  it('rejects a ref held by another pass, a foreign connection and half a binding', async () => {
    const a = await kit.pass();
    const b = await kit.pass();
    const connectionId = await connection();
    const bind = (id: string, body: unknown) =>
      api(`/passes/${id}/connection`, send('PUT', fake.admin(), body));
    expect((await bind(a.id, { connectionId, externalRef: 'dup' })).status).toBe(200);
    const taken = await bind(b.id, { connectionId, externalRef: 'dup' });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { code: string }).code).toBe('PASS_REF_TAKEN');
    const other = await makeOrg(kit.fx, { name: 'Elsewhere' });
    const foreign = await bind(b.id, {
      connectionId: await connection(other.id),
      externalRef: 'x',
    });
    expect(foreign.status).toBe(422);
    expect((await bind(b.id, { connectionId, externalRef: null })).status).toBe(422);
    expect((await getPass(kit.env.DB, b.id))?.connectionId).toBeNull();
  });
});

describe('validation and failures', () => {
  it('rejects serials that are not URL-safe', async () => {
    for (const serial of ['a/b', 'a?b', 'a b', 'a%b', 'a#b'])
      expect(
        (
          await api(
            '/passes',
            send('POST', fake.admin(), {
              orgId: kit.org.id,
              templateId: kit.template.id,
              input: { memberName: 'S' },
              serial,
            }),
          )
        ).status,
      ).toBe(422);
    const ok = await api(
      '/passes',
      send('POST', fake.admin(), {
        orgId: kit.org.id,
        templateId: kit.template.id,
        input: { memberName: 'S' },
        serial: 'ABC-123_x.y~z',
      }),
    );
    expect(ok.status).toBe(201);
  });

  it('answers 500, not 404, when the template registry fails', async () => {
    overrideDeps(kit.env, {
      registry: {
        list: (q) => kit.registry.list(q),
        openAsset: (t, n) => kit.registry.openAsset(t, n),
        resolve: async () => {
          throw new Error('D1_ERROR: Network connection lost.');
        },
      },
    });
    try {
      const res = await api(
        '/passes',
        send('POST', fake.admin(), {
          orgId: kit.org.id,
          templateId: kit.template.id,
          input: { memberName: 'S' },
        }),
      );
      expect(res.status).toBe(500);
    } finally {
      overrideDeps(kit.env, { registry: kit.registry });
    }
  });
});

describe('bulk reissue options', () => {
  it('accepts a re-sign limited to one identity', async () => {
    kit.workflow.created.length = 0;
    const pass = await kit.pass();
    const res = await api(
      '/passes/bulk-reissue',
      send('POST', fake.admin(), {
        templateId: kit.template.id,
        orgId: kit.org.id,
        cause: 'resign',
        identityId: pass.identityId,
      }),
    );
    expect(res.status).toBe(202);
    expect(kit.workflow.created[0]?.params).toMatchObject({
      cause: 'resign',
      identityId: pass.identityId,
      orgId: kit.org.id,
    });
  });
});
