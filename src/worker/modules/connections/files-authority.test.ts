import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeApiKey,
  makeOrg,
  makeSession,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { csvBody, MEMBERS, useUploadConnector } from './files-fixtures.ts';
import { insertConnection } from './repo.ts';
import { addMembership, type Kit, makeKit, withWorkflow } from './test-kit.ts';

let kit: Kit;
let session: SessionFixture;
let app: ReturnType<typeof createApp>;
let orgB: string;
let keyB: { headers: Record<string, string> };
beforeEach(async () => {
  kit = await makeKit();
  useUploadConnector();
  kit.env.CONNECTION_SYNC = withWorkflow(kit).sctx.env.CONNECTION_SYNC;
  session = await makeSession(kit, { userId: kit.actor.id, roles: ['admin', 'user'] });
  await addMembership(kit, kit.actor.id, ['org_admin']);
  orgB = (await makeOrg(kit)).id;
  keyB = await makeApiKey(kit, { orgId: orgB, scopes: ['connections:read', 'connections:write'] });
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});
afterEach(() => vi.restoreAllMocks());

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = session.headers,
) {
  const res = await app.request(
    path,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

/** Org A's draft, and a connection of org A bound to a second draft with a pending revision. */
async function orgAFiles() {
  const draft = await call(
    'POST',
    `/api/v1/connections/uploads?orgId=${kit.org.id}`,
    csvBody(MEMBERS),
  );
  const bound = await call(
    'POST',
    `/api/v1/connections/uploads?orgId=${kit.org.id}`,
    csvBody(MEMBERS, 'b.csv'),
  );
  const conn = await call('POST', '/api/v1/connections', {
    orgId: kit.org.id,
    connectorType: 'demo',
    name: 'A files',
    config: { idColumn: '/id' },
    mode: 'manual',
    fileId: bound.json.id,
  });
  const pending = await call(
    'POST',
    `/api/v1/connections/${conn.json.id}/files`,
    csvBody([...MEMBERS, ['m-9', 'N', 'n@example.com', '']]),
  );
  return {
    draft: draft.json.id as string,
    connection: conn.json.id as string,
    pending: pending.json.id as string,
  };
}

describe('files of another org', () => {
  it('cannot be read, re-read or discarded as a draft: it is not found', async () => {
    const a = await orgAFiles();
    for (const [method, body] of [['GET'], ['PATCH', {}], ['DELETE']] as const) {
      const res = await call(method, `/api/v1/connections/uploads/${a.draft}`, body, keyB.headers);
      expect(res.status).toBe(404);
      expect(res.json.code).toBe('FILE_NOT_FOUND');
    }
    expect((await call('GET', `/api/v1/connections/uploads/${a.draft}`)).status).toBe(200);
  });

  it('cannot be bound by a connection of org B, in the service or in the create grant', async () => {
    const a = await orgAFiles();
    const create = await call(
      'POST',
      '/api/v1/connections',
      {
        orgId: orgB,
        connectorType: 'demo',
        name: 'B',
        config: { idColumn: '/id' },
        mode: 'manual',
        fileId: a.draft,
      },
      keyB.headers,
    );
    expect(create.status).toBe(404);
    // Past the service check: the grant's own tenant guard refuses a draft of another org.
    const row = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM connections WHERE org_id = ?',
      [kit.org.id],
    );
    expect(row).not.toBeNull();
    const clone = {
      ...(await import('./repo.ts').then((m) => m.getConnection(kit.env.DB, String(row?.id)))),
    } as never as Parameters<typeof insertConnection>[1];
    await expect(
      insertConnection(
        kit.sctx,
        { ...clone, id: kit.ids.id(), orgId: orgB },
        { orgId: orgB },
        {
          fileId: a.draft,
          idPointer: '/id',
          bindId: 'b',
          sheet: null,
          recordsPointer: null,
          sha256: 'x',
          pages: 1,
          skippedNoId: 0,
          skippedDuplicate: 0,
          now: kit.clock.now(),
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await all(kit.env.DB, 'SELECT id FROM connections WHERE org_id = ?', [orgB])).toEqual(
      [],
    );
    expect(
      (
        await first<{ state: string }>(
          kit.env.DB,
          'SELECT state FROM connection_files WHERE id = ?',
          [a.draft],
        )
      )?.state,
    ).toBe('draft');
  });

  it('cannot be listed, uploaded to, applied or discarded through org A connection', async () => {
    const a = await orgAFiles();
    const base = `/api/v1/connections/${a.connection}/files`;
    for (const [method, path, body] of [
      ['GET', base],
      ['POST', base, csvBody(MEMBERS)],
      ['POST', `${base}/${a.pending}/apply`],
      ['DELETE', `${base}/${a.pending}`],
    ] as const) {
      const res = await call(method, path, body, keyB.headers);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const state = await first<{ state: string }>(
      kit.env.DB,
      'SELECT state FROM connection_files WHERE id = ?',
      [a.pending],
    );
    expect(state?.state).toBe('pending');
  });

  it('cannot get an upload started in org A by naming it', async () => {
    const res = await call(
      'POST',
      `/api/v1/connections/uploads?orgId=${kit.org.id}`,
      csvBody(MEMBERS),
      keyB.headers,
    );
    expect(res.status).toBe(403);
  });
});

describe('refusals within and across modes', () => {
  it('refuses a Test-mode key: stored files have no Test environment (L6)', async () => {
    const a = await orgAFiles();
    const test = await makeApiKey(kit, {
      orgId: kit.org.id,
      mode: 'test',
      scopes: ['connections:read', 'connections:write'],
    });
    for (const [method, path, body] of [
      ['POST', `/api/v1/connections/uploads?orgId=${kit.org.id}`, csvBody(MEMBERS)],
      ['GET', `/api/v1/connections/uploads/${a.draft}`],
      ['GET', `/api/v1/connections/${a.connection}/files`],
      ['POST', `/api/v1/connections/${a.connection}/files/${a.pending}/apply`],
    ] as const) {
      const res = await call(method, path, body, test.headers);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(
      (
        await first<{ state: string }>(
          kit.env.DB,
          'SELECT state FROM connection_files WHERE id = ?',
          [a.pending],
        )
      )?.state,
    ).toBe('pending');
  });

  it('refuses a read-only key on PATCH and DELETE of a draft (L6)', async () => {
    const a = await orgAFiles();
    const read = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:read'] });
    for (const [method, body] of [['PATCH', {}], ['DELETE']] as const) {
      const res = await call(method, `/api/v1/connections/uploads/${a.draft}`, body, read.headers);
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('MISSING_SCOPE');
    }
    expect(
      (
        await first<{ state: string }>(
          kit.env.DB,
          'SELECT state FROM connection_files WHERE id = ?',
          [a.draft],
        )
      )?.state,
    ).toBe('draft');
  });

  it('refuses a file of connection Y named through connection X in the same org (L6)', async () => {
    const x = await orgAFiles();
    const y = await orgAFiles();
    for (const [method, path] of [
      ['POST', `/api/v1/connections/${x.connection}/files/${y.pending}/apply`],
      ['DELETE', `/api/v1/connections/${x.connection}/files/${y.pending}`],
    ] as const) {
      const res = await call(method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.json.code).toBe('FILE_NOT_FOUND');
    }
    expect(
      (
        await first<{ state: string }>(
          kit.env.DB,
          'SELECT state FROM connection_files WHERE id = ?',
          [y.pending],
        )
      )?.state,
    ).toBe('pending');
  });
});
