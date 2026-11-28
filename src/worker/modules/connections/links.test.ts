import { beforeEach, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg, makeSession } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { seedPass } from './repo-test-pass-fixtures.ts';
import { addMembership, createDemo, type Kit, linkedPass, makeKit } from './test-kit.ts';

let kit: Kit;
let app: ReturnType<typeof createApp>;
let headers: Record<string, string>;
let id: string;
let passId: string;

beforeEach(async () => {
  kit = await makeKit();
  headers = (await makeSession(kit, { userId: kit.actor.id, roles: ['admin', 'user'] })).headers;
  await addMembership(kit, kit.actor.id, ['org_admin']);
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  id = (await createDemo(kit)).id;
  passId = (await seedPass(kit, kit.org.id, 'live')).id;
});

const call = (method: string, path: string, h = headers, body?: unknown) =>
  app.request(
    `/api/v1${path}`,
    {
      method,
      headers: { ...h, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    kit.env,
  );
const post = (body: unknown, h = headers, conn = id) =>
  call('POST', `/connections/${conn}/links`, h, body);
const links = (conn: string) =>
  all<{ role: string; object_type: string; external_id: string; local_id: string }>(
    kit.env.DB,
    'SELECT role, object_type, external_id, local_id FROM connection_links WHERE connection_id = ? ORDER BY role, external_id',
    [conn],
  );

describe('links', () => {
  it('binds, lists, finds and deletes a secondary link', async () => {
    const res = await post({ objectType: 'membership', externalId: 'm-1', localId: passId });
    expect(res.status).toBe(201);
    const link = (await res.json()) as { id: string; role: string; state: string };
    expect(link).toMatchObject({ role: 'secondary', state: 'active' });
    const list = (await (await call('GET', `/connections/${id}/links`)).json()) as {
      items: { id: string }[];
    };
    expect(list.items.map((l) => l.id)).toEqual([link.id]);
    const found = (await (
      await call('GET', `/links?connectionId=${id}&objectType=membership&externalId=m-1`)
    ).json()) as { items: { id: string }[] };
    expect(found.items).toHaveLength(1);
    const none = (await (await call('GET', `/links?connectionId=${id}&externalId=zzz`)).json()) as {
      items: unknown[];
    };
    expect(none.items).toEqual([]);
    expect((await call('DELETE', `/connections/${id}/links/${link.id}`)).status).toBe(200);
    expect(await links(id)).toEqual([]);
    expect((await call('DELETE', `/connections/${id}/links/${link.id}`)).status).toBe(404);
  });

  it('is unique per external id and per local id within a connection and object', async () => {
    const other = (await seedPass(kit, kit.org.id, 'live')).id;
    const body = { objectType: 'membership', externalId: 'm-1', localId: passId };
    expect((await post(body)).status).toBe(201);
    const sameExternal = await post({ ...body, localId: other });
    expect(sameExternal.status).toBe(409);
    expect(((await sameExternal.json()) as { code: string }).code).toBe('LINK_EXISTS');
    expect((await post({ ...body, externalId: 'm-2' })).status).toBe(409);
    expect((await post({ ...body, objectType: 'plan' })).status).toBe(201);
  });

  it('keeps the reserved record type and primary links out of the API', async () => {
    expect((await post({ objectType: 'record', externalId: 'x', localId: passId })).status).toBe(
      422,
    );
    await linkedPass(kit, id, 'ref-1');
    const primary = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM connection_links WHERE role = 'primary'",
    );
    const res = await call('DELETE', `/connections/${id}/links/${primary?.id}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('LINK_PRIMARY');
  });

  it('mirrors the primary binding on insert, bind, rebind, unbind and delete', async () => {
    const bound = await linkedPass(kit, id, 'ref-1');
    expect(await links(id)).toEqual([
      { role: 'primary', object_type: 'record', external_id: 'ref-1', local_id: bound.id },
    ]);
    const bind = (ref: string | null, conn: string | null) =>
      run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
        conn,
        ref,
        passId,
      ]);
    await bind('ref-2', id);
    expect((await links(id)).map((l) => l.external_id)).toEqual(['ref-1', 'ref-2']);
    await bind('ref-3', id);
    expect((await links(id)).map((l) => l.external_id)).toEqual(['ref-1', 'ref-3']);
    await bind(null, null);
    expect((await links(id)).map((l) => l.external_id)).toEqual(['ref-1']);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [bound.id]);
    expect(await links(id)).toEqual([]);
  });

  it('mirrors the primary binding through PUT /passes/{id}/connection', async () => {
    const res = await call('PUT', `/passes/${passId}/connection`, headers, {
      connectionId: id,
      externalRef: 'ref-9',
    });
    expect(res.status).toBe(200);
    expect((await links(id)).map((l) => [l.role, l.external_id])).toEqual([['primary', 'ref-9']]);
    await call('PUT', `/passes/${passId}/connection`, headers, {
      connectionId: null,
      externalRef: null,
    });
    expect(await links(id)).toEqual([]);
  });

  it('drops a connection’s links with the connection', async () => {
    await linkedPass(kit, id, 'ref-1');
    await post({ objectType: 'membership', externalId: 'm-1', localId: passId });
    await run(kit.env.DB, 'DELETE FROM connections WHERE id = ?', [id]);
    expect(await links(id)).toEqual([]);
  });

  describe('tenant isolation and scopes', () => {
    it('hides links and refuses writes across orgs', async () => {
      const other = await makeOrg(kit);
      const otherConn = (await createDemo(kit, { orgId: other.id } as never)).id;
      const foreignPass = (await seedPass(kit, other.id, 'live')).id;
      await post({ objectType: 'membership', externalId: 'm-1', localId: passId });
      const key = await makeApiKey(kit, {
        orgId: other.id,
        scopes: ['connections:read', 'connections:write'],
      });
      expect((await call('GET', `/connections/${id}/links`, key.headers)).status).toBe(404);
      expect((await call('GET', `/links?connectionId=${id}`, key.headers)).status).toBe(404);
      const mine = (await (await call('GET', '/links', key.headers)).json()) as {
        items: unknown[];
      };
      expect(mine.items).toEqual([]);
      const linkId = (
        await first<{ id: string }>(
          kit.env.DB,
          'SELECT id FROM connection_links WHERE connection_id = ?',
          [id],
        )
      )?.id;
      expect((await call('DELETE', `/connections/${id}/links/${linkId}`, key.headers)).status).toBe(
        404,
      );
      expect(await links(id)).toHaveLength(1);
      expect(
        (await post({ objectType: 'm', externalId: 'x', localId: passId }, key.headers, otherConn))
          .status,
      ).toBe(422);
      expect(
        (await post({ objectType: 'm', externalId: 'x', localId: foreignPass }, headers, id))
          .status,
      ).toBe(422);
    });

    it('needs connections:read to list and connections:write to change', async () => {
      const read = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:read'] });
      const write = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
      const body = { objectType: 'membership', externalId: 'm-1', localId: passId };
      expect((await post(body, read.headers)).status).toBe(403);
      expect((await post(body, write.headers)).status).toBe(201);
      expect((await call('GET', `/connections/${id}/links`, read.headers)).status).toBe(200);
      expect((await call('GET', `/connections/${id}/links`, write.headers)).status).toBe(403);
      expect((await call('GET', `/links?connectionId=${id}`, write.headers)).status).toBe(403);
      const linkId = (
        await first<{ id: string }>(
          kit.env.DB,
          'SELECT id FROM connection_links WHERE connection_id = ?',
          [id],
        )
      )?.id;
      expect(
        (await call('DELETE', `/connections/${id}/links/${linkId}`, read.headers)).status,
      ).toBe(403);
      expect(
        (await call('DELETE', `/connections/${id}/links/${linkId}`, write.headers)).status,
      ).toBe(200);
    });
  });
});
