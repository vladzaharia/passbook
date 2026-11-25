import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApiKey, makeSession, type SessionFixture } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { doneCursor } from './files-dto.ts';
import { csvBody, MEMBERS, useUploadConnector } from './files-test-kit.ts';
import { addMembership, type Kit, makeKit, withWorkflow } from './test-kit.ts';

let kit: Kit;
let session: SessionFixture;
let app: ReturnType<typeof createApp>;
let workflow: ReturnType<typeof withWorkflow>;
beforeEach(async () => {
  kit = await makeKit();
  useUploadConnector();
  workflow = withWorkflow(kit);
  kit.env.CONNECTION_SYNC = workflow.sctx.env.CONNECTION_SYNC;
  session = await makeSession(kit, { userId: kit.actor.id, roles: ['admin', 'user'] });
  await addMembership(kit, kit.actor.id, ['org_admin']);
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
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    },
    kit.env,
  );
  const text = await res.text();
  return { status: res.status, res, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

const upload = (rows: string[][], headers?: Record<string, string>, name?: string) =>
  call('POST', `/api/v1/connections/uploads?orgId=${kit.org.id}`, csvBody(rows, name), headers);
const files = (id: string, query = '') => `/api/v1/connections/${id}/files${query}`;

async function connection(rows = MEMBERS) {
  const draft = await upload(rows);
  expect(draft.status).toBe(201);
  const created = await call('POST', '/api/v1/connections', {
    orgId: kit.org.id,
    connectorType: 'demo',
    name: 'Members file',
    config: { idColumn: '/id' },
    mode: 'manual',
    fileId: draft.json.id,
  });
  expect(created.status).toBe(201);
  return { id: created.json.id as string, fileId: draft.json.id as string };
}

describe('draft routes', () => {
  it('uploads, reads, re-reads and discards a draft', async () => {
    const d = await upload(MEMBERS);
    expect(d.status).toBe(201);
    expect(d.json).toMatchObject({
      state: 'draft',
      rows: 3,
      idCandidates: ['/id', '/name', '/email', '/joined'].slice(0, 4),
    });
    expect((await call('GET', `/api/v1/connections/uploads/${d.json.id}`)).json.id).toBe(d.json.id);
    const patched = await call('PATCH', `/api/v1/connections/uploads/${d.json.id}`, {});
    expect(patched.status).toBe(200);
    expect((await call('DELETE', `/api/v1/connections/uploads/${d.json.id}`)).json).toEqual({
      ok: true,
    });
    expect((await call('GET', `/api/v1/connections/uploads/${d.json.id}`)).status).toBe(404);
  });

  it('replays an upload with the same Idempotency-Key and stores one file', async () => {
    const headers = { ...session.headers, 'idempotency-key': 'nightly-1' };
    const a = await upload(MEMBERS, headers);
    const b = await upload(MEMBERS, headers);
    expect(b.json.id).toBe(a.json.id);
    expect(b.res.headers.get('idempotent-replayed')).toBe('true');
    const n = await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM connection_files WHERE org_id = ?',
      [kit.org.id],
    );
    expect(n?.n).toBe(1);
  });

  it('takes an upload above the default 256 KB cap and refuses one above 7 MB', async () => {
    const rows = [
      ['id', 'note'],
      ...Array.from({ length: 400 }, (_, i) => [`r${i}`, 'x'.repeat(900)]),
    ];
    expect((await upload(rows)).status).toBe(201);
    const huge = await call(
      'POST',
      `/api/v1/connections/uploads?orgId=${kit.org.id}`,
      'x'.repeat(7 * 1024 * 1024 + 10),
    );
    expect(huge.status).toBe(413);
  });

  it('refuses fileId on test-config for a connector without uploads', async () => {
    const d = await upload(MEMBERS);
    const res = await call('POST', '/api/v1/connections/test-config', {
      orgId: kit.org.id,
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com/v1' },
      fileId: d.json.id,
    });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('VALIDATION');
  });
});

describe('revisions', () => {
  const NEXT = [
    ['id', 'name', 'email', 'joined'],
    ['m-1', 'Ada Lovelace', 'ada@example.com', '2026-01-02'],
    ['m-2', 'Grace', 'grace@example.com', '2026-02-03'],
    ['m-4', 'Ken', 'ken@example.com', '2026-04-05'],
  ];

  it('binds the draft as revision 1 and lists it', async () => {
    const { id, fileId } = await connection();
    const list = await call('GET', files(id));
    expect(list.status).toBe(200);
    expect(list.json.items).toHaveLength(1);
    expect(list.json.items[0]).toMatchObject({
      id: fileId,
      revision: 1,
      state: 'current',
      rows: 3,
      diff: null,
      applied: false,
      createdBy: kit.actor.id,
    });
  });

  it('stores a new revision as pending with a diff, and returns unchanged for the same bytes', async () => {
    const { id } = await connection();
    const same = await call('POST', files(id), csvBody(MEMBERS));
    expect(same).toMatchObject({ status: 200, json: { unchanged: true } });
    const next = await call('POST', files(id), csvBody(NEXT));
    expect(next.status).toBe(200);
    expect(next.json).toMatchObject({
      unchanged: false,
      revision: 2,
      state: 'pending',
      diff: {
        added: 1,
        changed: 1,
        removed: 1,
        examples: { added: ['m-4'], changed: ['m-1'], removed: ['m-3'] },
      },
    });
    const n = await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM connection_files WHERE connection_id = ?',
      [id],
    );
    expect(n?.n).toBe(2);
  });

  it('replaces an older pending revision and deletes its objects', async () => {
    const { id } = await connection();
    const first = await call('POST', files(id), csvBody(NEXT));
    const second = await call(
      'POST',
      files(id),
      csvBody([...NEXT, ['m-5', 'Z', 'z@example.com', '']]),
    );
    expect(second.json.revision).toBe(3);
    const states = await all<{ id: string; state: string }>(
      kit.env.DB,
      'SELECT id, state FROM connection_files WHERE connection_id = ? ORDER BY revision',
      [id],
    );
    expect(states.map((r) => r.state)).toEqual(['current', 'discarded', 'pending']);
    expect(
      await kit.env.BUCKET.head(`uploads/connection-files/${kit.org.id}/${first.json.id}/source`),
    ).toBeNull();
  });

  it('applies a pending revision: it becomes current, the old one superseded, and a sync starts', async () => {
    const { id, fileId } = await connection();
    const next = await call('POST', files(id), csvBody(NEXT));
    const applied = await call('POST', files(id, `/${next.json.id}/apply`));
    expect(applied.status).toBe(200);
    expect(applied.json.file).toMatchObject({ id: next.json.id, state: 'current' });
    expect(applied.json.runId).toBeTruthy();
    expect(workflow.created).toHaveLength(1);
    const rows = await all<{ id: string; state: string }>(
      kit.env.DB,
      'SELECT id, state FROM connection_files WHERE connection_id = ? ORDER BY revision',
      [id],
    );
    expect(rows).toEqual([
      { id: fileId, state: 'superseded' },
      { id: next.json.id, state: 'current' },
    ]);
    const again = await call('POST', files(id, `/${next.json.id}/apply`));
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('FILE_STATE');
  });

  it('uploads and applies in one call with apply=true', async () => {
    const { id } = await connection();
    const res = await call('POST', files(id, '?apply=true'), csvBody(NEXT));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ unchanged: false, state: 'current', revision: 2 });
    expect(res.json.runId).toBeTruthy();
  });

  it('refuses to apply an expired revision', async () => {
    const { id } = await connection();
    const next = await call('POST', files(id), csvBody(NEXT));
    await run(kit.env.DB, 'UPDATE connection_files SET expires_at = ? WHERE id = ?', [
      kit.clock.now() - 1,
      next.json.id,
    ]);
    const res = await call('POST', files(id, `/${next.json.id}/apply`));
    expect(res.status).toBe(410);
    expect(res.json.code).toBe('FILE_EXPIRED');
  });

  it('discards a pending revision but not a current one', async () => {
    const { id, fileId } = await connection();
    const next = await call('POST', files(id), csvBody(NEXT));
    expect((await call('DELETE', files(id, `/${next.json.id}`))).json).toEqual({ ok: true });
    expect(
      await kit.env.BUCKET.head(`uploads/connection-files/${kit.org.id}/${next.json.id}/source`),
    ).toBeNull();
    const refused = await call('DELETE', files(id, `/${fileId}`));
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('FILE_STATE');
  });

  it('shows Applied when the connector left the done cursor', async () => {
    const { id, fileId } = await connection();
    await run(kit.env.DB, 'UPDATE connections SET cursor = ? WHERE id = ?', [
      doneCursor(fileId),
      id,
    ]);
    expect((await call('GET', files(id))).json.items[0].applied).toBe(true);
  });

  it('deletes a connection with its file rows first and its objects after', async () => {
    const { id, fileId } = await connection();
    const next = await call('POST', files(id), csvBody(NEXT));
    expect((await call('DELETE', `/api/v1/connections/${id}`)).status).toBe(200);
    expect(
      await all(kit.env.DB, 'SELECT id FROM connection_files WHERE org_id = ?', [kit.org.id]),
    ).toEqual([]);
    const left = await kit.env.BUCKET.list({ prefix: `uploads/connection-files/${kit.org.id}/` });
    expect(left.objects).toEqual([]);
    expect([fileId, next.json.id].length).toBe(2);
  });
});

describe('scopes', () => {
  it('needs connections:write to upload and connections:read to list', async () => {
    const { id } = await connection();
    const write = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
    const read = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:read'] });
    expect((await upload(MEMBERS, read.headers)).status).toBe(403);
    expect((await call('POST', files(id), csvBody(MEMBERS), read.headers)).status).toBe(403);
    expect((await call('GET', files(id), undefined, write.headers)).status).toBe(403);
    expect((await call('GET', files(id), undefined, read.headers)).status).toBe(200);
    expect((await upload(MEMBERS, write.headers)).status).toBe(201);
    expect(
      (
        await call(
          'POST',
          files(id, '?apply=true'),
          csvBody([...MEMBERS, ['m-9', 'N', 'n@example.com', '']]),
          write.headers,
        )
      ).status,
    ).toBe(200);
  });
});
