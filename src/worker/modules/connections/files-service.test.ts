import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSession } from '../../../../test/helpers/index.ts';
import { TabularError } from '../../../shared/tabular/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { authorizeConnection, type ConnectionAuthority } from './access.ts';
import { rejectFile } from './files-errors.ts';
import { createUpload, csvBody, MEMBERS, useUploadConnector } from './files-fixtures.ts';
import { parseFile } from './files-parse.ts';
import { filesPort } from './files-port.ts';
import { createDraft, discardDraft, readDraft, reparseDraft, takeUpload } from './files-service.ts';
import * as store from './files-store.ts';
import { getFile } from './repo-files.ts';
import { addMembership, createDemo, type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
let authority: ConnectionAuthority;
beforeEach(async () => {
  kit = await makeKit();
  useUploadConnector();
  await addMembership(kit, kit.actor.id, ['integration_admin']);
  const fixture = await makeSession(kit, { userId: kit.actor.id });
  const session = (await createSessionStore(kit.env, kit.clock).resolve(
    fixture.cookieValue,
  )) as SessionAuth;
  authority = await authorizeConnection(kit.sctx, session, kit.org.id, 'integrations:manage');
});
afterEach(() => vi.restoreAllMocks());

const draft = (rows = MEMBERS, name?: string) =>
  createDraft(kit.sctx, kit.actor, authority, csvBody(rows, name));
const keysOf = async (fileId: string) =>
  (
    await kit.env.BUCKET.list({ prefix: `uploads/connection-files/${kit.org.id}/${fileId}/` })
  ).objects.map((o) => o.key.split('/').slice(4).join('/'));

describe('draft upload', () => {
  it('parses the file, describes its columns and keeps source and summary in R2', async () => {
    const d = await draft();
    expect(d).toMatchObject({ state: 'draft', format: 'csv', rows: 3, orgId: kit.org.id });
    expect(d.columns.map((c) => [c.pointer, c.type])).toEqual([
      ['/id', 'text'],
      ['/name', 'text'],
      ['/email', 'email'],
      ['/joined', 'date'],
    ]);
    expect(d.idCandidates[0]).toBe('/id');
    expect(d.preview.rows).toHaveLength(3);
    expect(d.expiresAt).toBe(kit.clock.now() + 23 * 3_600_000);
    expect((await keysOf(d.id)).sort()).toEqual(['source', 'summary.json']);
    expect(await readDraft(kit.sctx, kit.org.id, d.id)).toEqual(d);
  });

  it('counts blanks and repeats per column and ranks unique filled columns first', async () => {
    const d = await draft([
      ['name', 'code'],
      ['Ada', 'x1'],
      ['Ada', ''],
      ['Bob', 'x3'],
    ]);
    expect(d.columns.find((c) => c.label === 'name')).toMatchObject({ blanks: 0, duplicates: 1 });
    expect(d.columns.find((c) => c.label === 'code')).toMatchObject({ blanks: 1, duplicates: 0 });
    expect(d.idCandidates).toEqual(['/code', '/name']);
  });

  it('refuses a file over 5 MB with FILE_TOO_LARGE (413)', async () => {
    const big = {
      name: 'big.csv',
      content: 'a'.repeat(5 * 1024 * 1024 + 1),
      encoding: 'utf8' as const,
    };
    await expect(createDraft(kit.sctx, kit.actor, authority, big)).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
      status: 413,
    });
  });

  it('maps parser codes to statuses and never carries file content', async () => {
    await expect(draft([['a', 'b']])).rejects.toMatchObject({ code: 'FILE_EMPTY', status: 422 });
    const status = (code: ConstructorParameters<typeof TabularError>[0]) => {
      try {
        rejectFile(kit.sctx, kit.org.id, new TabularError(code, 'One sentence.'));
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    expect([status('FILE_BAD_POINTER'), status('FILE_SHEET_NOT_FOUND')]).toEqual([400, 400]);
    expect([status('FILE_MACRO'), status('FILE_ENCODING'), status('FILE_ARCHIVE_LIMIT')]).toEqual([
      422, 422, 422,
    ]);
  });

  it('logs the name of the exception behind FILE_DAMAGED, never its message', async () => {
    const errors: { event: string; data: Record<string, unknown> }[] = [];
    const ctx = {
      ...kit.sctx,
      log: {
        ...kit.sctx.log,
        error: (event: string, data: Record<string, unknown>) => errors.push({ event, data }),
      },
    };
    const cause = new RangeError('secret cell value');
    expect(() =>
      rejectFile(
        ctx,
        kit.org.id,
        new TabularError('FILE_DAMAGED', 'The file could not be read.', cause),
      ),
    ).toThrow(expect.objectContaining({ code: 'FILE_DAMAGED', status: 422 }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.data).toMatchObject({ code: 'FILE_DAMAGED', errorName: 'RangeError' });
    expect(JSON.stringify(errors)).not.toContain('secret cell value');
  });

  it('allows 30 uploads or re-reads an hour per org, counting PATCH re-parses', async () => {
    for (let i = 0; i < 29; i++) await takeUpload(kit.sctx, kit.org.id);
    const d = await draft();
    await expect(takeUpload(kit.sctx, kit.org.id)).rejects.toMatchObject({ status: 429 });
    await expect(reparseDraft(kit.sctx, authority, d.id, {})).rejects.toMatchObject({
      status: 429,
    });
  });

  it('opens a new allowance each hour', async () => {
    for (let i = 0; i < 30; i++) await takeUpload(kit.sctx, kit.org.id);
    await expect(takeUpload(kit.sctx, kit.org.id)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    kit.clock.advance(3_600_000);
    await expect(takeUpload(kit.sctx, kit.org.id)).resolves.toBeUndefined();
  });

  it('keeps at most 20 open drafts per org', async () => {
    for (let i = 0; i < 20; i++) await draft(MEMBERS, `f${i}.csv`);
    await expect(draft()).rejects.toMatchObject({ status: 429 });
  });

  it('re-parses a draft from its stored source with another records path', async () => {
    const json = {
      name: 'm.json',
      content: JSON.stringify({ a: [{ id: 1 }], b: [{ id: 2, extra: true }, { id: 3 }] }),
      encoding: 'utf8' as const,
    };
    const d = await createDraft(kit.sctx, kit.actor, authority, json);
    const again = await reparseDraft(kit.sctx, authority, d.id, { recordsPointer: '/a' });
    expect(again).toMatchObject({ rows: 1, recordsPointer: '/a' });
    expect(again.columns.map((c) => c.label)).toEqual(['id']);
    await expect(
      reparseDraft(kit.sctx, authority, d.id, { recordsPointer: '/nope' }),
    ).rejects.toMatchObject({ code: 'FILE_RECORDS_NOT_FOUND' });
  });

  it('discards a draft: row first, then every object', async () => {
    const d = await draft();
    await discardDraft(kit.sctx, kit.actor, authority, d.id);
    expect((await getFile(kit.env.DB, kit.org.id, d.id))?.state).toBe('discarded');
    expect(await keysOf(d.id)).toEqual([]);
    await expect(readDraft(kit.sctx, kit.org.id, d.id)).rejects.toMatchObject({ status: 404 });
  });

  it('answers FILE_EXPIRED once the 23 hours pass', async () => {
    const d = await draft();
    kit.clock.advance(23 * 3_600_000);
    await expect(readDraft(kit.sctx, kit.org.id, d.id)).rejects.toMatchObject({
      code: 'FILE_EXPIRED',
      status: 410,
    });
  });
});

describe('bind at create', () => {
  it('turns the draft into revision 1: pages, refs and the skipped counts', async () => {
    const d = await draft([
      ...MEMBERS,
      ['m-2', 'Dup', 'd@example.com', ''],
      ['', 'Nobody', '', ''],
    ]);
    const conn = await createUpload(kit, d.id);
    const row = await getFile(kit.env.DB, kit.org.id, d.id);
    expect(row).toMatchObject({
      state: 'current',
      revision: 1,
      connectionId: conn.id,
      idPointer: '/id',
      pages: 1,
      skippedNoId: 1,
      skippedDuplicate: 1,
      expiresAt: null,
    });
    const bound = await getFile(kit.env.DB, kit.org.id, d.id);
    expect(bound?.bindId).toBeTruthy();
    expect((await keysOf(d.id)).sort()).toEqual([
      `rows/${bound?.bindId}/0.json`,
      `rows/${bound?.bindId}/refs.json`,
      'source',
      'summary.json',
    ]);
    const files = filesPort(kit.sctx, { orgId: kit.org.id, connectionId: conn.id });
    expect(await files.current()).toMatchObject({
      id: d.id,
      revision: 1,
      rows: 5,
      pages: 1,
      columns: ['id', 'name', 'email', 'joined'],
      skipped: { noId: 1, duplicate: 1 },
    });
    expect((await files.refs(d.id)).map((r) => r.ref)).toEqual(['m-1', 'm-2', 'm-3']);
    expect((await files.page(d.id, 0)).map((e) => e.ref)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(await files.find(d.id, 'm-2')).toMatchObject({ name: 'Grace' });
    expect(await files.find(d.id, 'zz')).toBeNull();
  });

  it('refuses fileId on a connector without the upload capability, and a create without one', async () => {
    const d = await draft();
    await expect(
      createDemo(kit, { fileId: d.id, config: { count: 1 } } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createUpload(kit, undefined as never)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('refuses an ID column the file lacks (FILE_ID_COLUMN_MISSING) and one with no values', async () => {
    const d = await draft();
    await expect(createUpload(kit, d.id, { config: { idColumn: '/nope' } })).rejects.toMatchObject({
      code: 'FILE_ID_COLUMN_MISSING',
      status: 422,
    });
    const blank = await draft([
      ['id', 'n'],
      ['', 'a'],
      [' ', 'b'],
    ]);
    await expect(createUpload(kit, blank.id)).rejects.toMatchObject({
      code: 'FILE_ID_COLUMN_MISSING',
    });
  });

  it('refuses an expired draft and one that is already bound', async () => {
    const d = await draft();
    await createUpload(kit, d.id);
    await expect(createUpload(kit, d.id)).rejects.toMatchObject({ status: 404 });
    const e = await draft(MEMBERS, 'e.csv');
    kit.clock.advance(24 * 3_600_000);
    await expect(createUpload(kit, e.id)).rejects.toMatchObject({ code: 'FILE_EXPIRED' });
  });

  it('refuses at commit when the draft ended after it was read (CAS), and creates nothing', async () => {
    const d = await draft();
    const original = store.writeRows;
    vi.spyOn(store, 'writeRows').mockImplementation(async (...args) => {
      const written = await original(...args);
      await run(kit.env.DB, "UPDATE connection_files SET state = 'discarded' WHERE id = ?", [d.id]);
      return written;
    });
    await expect(createUpload(kit, d.id)).rejects.toMatchObject({ status: 409 });
    expect(
      await first(kit.env.DB, 'SELECT id FROM connections WHERE org_id = ?', [kit.org.id]),
    ).toBeNull();
  });

  it('stores zone-less datetimes in the org zone, never UTC', async () => {
    const d = await createDraft(kit.sctx, kit.actor, authority, {
      name: 'j.json',
      encoding: 'utf8',
      content: JSON.stringify([
        { id: 'a', at: '2026-07-01T09:30:00', day: '2026-07-01', z: '2026-07-01T09:30:00Z' },
        { id: 'b', at: '2026-12-01T09:30:00' },
      ]),
    });
    const conn = await createUpload(kit, d.id);
    const files = filesPort(kit.sctx, { orgId: kit.org.id, connectionId: conn.id });
    expect(await files.find(d.id, 'a')).toMatchObject({
      at: '2026-07-01T09:30:00-07:00',
      day: '2026-07-01',
      z: '2026-07-01T09:30:00Z',
    });
    expect(await files.find(d.id, 'b')).toMatchObject({ at: '2026-12-01T09:30:00-08:00' });
  });

  it('copies records with an own __proto__ key and checks nested string lengths', async () => {
    const d = await createDraft(kit.sctx, kit.actor, authority, {
      name: 'p.json',
      encoding: 'utf8',
      content: '[{"id":"a","__proto__":{"x":1},"n":{"deep":"ok"}}]',
    });
    const conn = await createUpload(kit, d.id);
    const record = await filesPort(kit.sctx, { orgId: kit.org.id, connectionId: conn.id }).find(
      d.id,
      'a',
    );
    expect(Object.hasOwn(record ?? {}, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    const long = JSON.stringify([{ id: 'a', n: { deep: 'x'.repeat(2001) } }]);
    await expect(
      createDraft(kit.sctx, kit.actor, authority, {
        name: 'l.json',
        encoding: 'utf8',
        content: long,
      }),
    ).rejects.toMatchObject({ code: 'FILE_CELL_TOO_LONG' });
  });
});

describe('bind pins what it read', () => {
  it('refuses at commit when the draft was re-read with another sha or sheet (L1), and creates nothing', async () => {
    const d = await draft();
    const original = store.writeRows;
    vi.spyOn(store, 'writeRows').mockImplementation(async (...args) => {
      const written = await original(...args);
      await run(kit.env.DB, "UPDATE connection_files SET sha256 = 'other' WHERE id = ?", [d.id]);
      return written;
    });
    await expect(createUpload(kit, d.id)).rejects.toMatchObject({ status: 409 });
    expect(
      await first(kit.env.DB, 'SELECT id FROM connections WHERE org_id = ?', [kit.org.id]),
    ).toBeNull();
  });
});

describe('entitlement', () => {
  it('needs file-upload on the plan to upload a draft, before the allowance is spent', async () => {
    await run(
      kit.env.DB,
      `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'connectors', '["demo"]', 1)`,
      [kit.org.id],
    );
    await expect(draft()).rejects.toMatchObject({ code: 'FEATURE_NOT_INCLUDED', status: 403 });
    const used = await first(kit.env.DB, 'SELECT count FROM counters WHERE key = ?', [
      `connection-file-upload:${kit.org.id}`,
    ]);
    expect(used).toBeNull();
  });
});

describe('maximum size', () => {
  const rows = 10_000;
  const cells = (i: number) =>
    Object.fromEntries(
      Array.from({ length: 12 }, (_, c) => [`c${c}`, `v${i}-${c}-${'x'.repeat(8)}`]),
    );
  const text = {
    csv: () =>
      [
        Array.from({ length: 12 }, (_, c) => `c${c}`).join(','),
        ...Array.from({ length: rows }, (_, i) => Object.values(cells(i)).join(',')),
      ].join('\n'),
    json: () => JSON.stringify(Array.from({ length: rows }, (_, i) => cells(i))),
    ndjson: () => Array.from({ length: rows }, (_, i) => JSON.stringify(cells(i))).join('\n'),
  };
  for (const format of ['csv', 'json', 'ndjson'] as const)
    it(`parses and stores ${rows} ${format} rows by converting them in place`, async () => {
      const bytes = new TextEncoder().encode(text[format]());
      const parsed = parseFile(kit.sctx, kit.org.id, bytes, {}, 'America/Los_Angeles');
      expect(parsed.records).toHaveLength(rows);
      expect(parsed.columns).toHaveLength(12);
      expect(parsed.records[rows - 1]?.c11).toBe(`v${rows - 1}-11-${'x'.repeat(8)}`);
    });
});

describe('unsaved test over a draft', () => {
  it('reads the draft through the port without any stored pages', async () => {
    const d = await draft();
    const files = filesPort(kit.sctx, { orgId: kit.org.id, draftId: d.id, idPointer: '/id' });
    expect(await files.current()).toMatchObject({ id: d.id, revision: null, rows: 3, pages: 1 });
    expect((await files.page(d.id, 0)).map((e) => e.ref)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(await files.previous(3)).toEqual([]);
    expect(await filesPort(kit.sctx, { orgId: kit.org.id, draftId: null }).current()).toBeNull();
    expect(
      await all(kit.env.DB, 'SELECT id FROM connection_files WHERE org_id = ?', [kit.org.id]),
    ).toHaveLength(1);
  });
});
