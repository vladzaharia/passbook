import { describe, expect, it } from 'vitest';
import {
  type ConnectionFilesPort,
  type ConnectorContext,
  ConnectorError,
  type ConnectorFile,
  type UpstreamRecord,
} from '../types.ts';
import { basesFor, decode, encode } from './cursor.ts';
import definition from './index.ts';

interface Fake {
  id: string;
  rows: string[];
}
const PAGE = 2;

/** In-memory files: `current` is the newest, `previous` the rest, newest first. */
function port(current: Fake | null, previous: Fake[] = []): ConnectionFilesPort {
  const all = current ? [current, ...previous] : [];
  const fileOf = (f: Fake): ConnectorFile => ({
    id: f.id,
    revision: 1,
    format: 'csv',
    rows: f.rows.length,
    columns: ['id', 'name'],
    pages: Math.ceil(f.rows.length / PAGE),
    skipped: { noId: 0, duplicate: 0 },
  });
  const find = (id: string) => {
    const f = all.find((x) => x.id === id);
    if (!f) throw new ConnectorError('CONFIG', { permanent: true });
    return f;
  };
  const rec = (ref: string): UpstreamRecord => ({ id: ref, name: `n-${ref}` });
  return {
    current: async () => (current ? fileOf(current) : null),
    previous: async (limit) => previous.slice(0, limit).map(fileOf),
    page: async (id, n) =>
      find(id)
        .rows.slice(n * PAGE, (n + 1) * PAGE)
        .map((ref) => ({ ref, record: rec(ref) })),
    refs: async (id) =>
      find(id).rows.map((ref, i) => ({ ref, digest: 'd', page: Math.floor(i / PAGE) })),
    find: async (id, ref) => (find(id).rows.includes(ref) ? rec(ref) : null),
  };
}

const ctx = (files?: ConnectionFilesPort) =>
  ({
    connection: { id: 'c', orgId: 'o', generation: 1, config: { idColumn: '/id' } },
    secrets: undefined,
    now: () => 0,
    fetch: async () => {
      throw new Error('no network');
    },
    ...(files ? { files } : {}),
    signal: new AbortController().signal,
    log: () => undefined,
  }) as ConnectorContext<{ idColumn: string }, unknown>;

/** Runs listChanges to the end; returns every change and the final cursor. */
async function drain(files: ConnectionFilesPort, from: string | null) {
  const changes: { ref: string; record?: UpstreamRecord; deleted?: boolean }[] = [];
  let cursor = from;
  for (let i = 0; i < 50; i++) {
    const r = await definition.listChanges?.(ctx(files), cursor);
    if (!r) throw new Error('no listChanges');
    changes.push(...r.changes);
    cursor = r.cursor;
    if (!r.hasMore) return { changes, cursor };
  }
  throw new Error('never ended');
}

const v1 = { id: 'f1', rows: ['a', 'b', 'c', 'd', 'e'] };
const v2 = { id: 'f2', rows: ['a', 'c', 'e', 'x'] };

describe('definition', () => {
  it('is a manual, upload-only connector with no network and a fixed ID column', () => {
    expect(definition).toMatchObject({
      type: 'file-upload',
      capabilities: { upload: true },
      fixedConfig: ['idColumn'],
    });
    expect(definition.egress?.({ idColumn: '/id' })).toEqual([]);
    expect(definition.configSchema.safeParse({ idColumn: 'id' }).success).toBe(false);
    expect(definition.configSchema.safeParse({ idColumn: '/Member ID' }).success).toBe(true);
  });
});

describe('listChanges', () => {
  it('emits every row of the first revision, then finishes at the done cursor', async () => {
    const { changes, cursor } = await drain(port(v1), null);
    expect(changes.map((c) => c.ref)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(changes.every((c) => c.record && !c.deleted)).toBe(true);
    expect(cursor).toBe('fu1:f1:-:done:0');
  });

  it('is a no-op once done', async () => {
    const r = await definition.listChanges?.(ctx(port(v1)), 'fu1:f1:-:done:0');
    expect(r).toEqual({ changes: [], cursor: 'fu1:f1:-:done:0', hasMore: false });
  });

  it('re-emits all rows of a new revision and deletes what it lost', async () => {
    const { changes, cursor } = await drain(port(v2, [v1]), 'fu1:f1:-:done:0');
    expect(changes.filter((c) => !c.deleted).map((c) => c.ref)).toEqual(['a', 'c', 'e', 'x']);
    expect(changes.filter((c) => c.deleted)).toEqual([
      { ref: 'b', deleted: true },
      { ref: 'd', deleted: true },
    ]);
    expect(cursor).toBe('fu1:f2:-:done:0');
  });

  it('a null cursor diffs against every retained revision', async () => {
    const { changes } = await drain(port(v2, [v1]), null);
    expect(changes.filter((c) => c.deleted).map((c) => c.ref)).toEqual(['b', 'd']);
  });

  it('unions the bases when a revision lands mid-run', async () => {
    const v3 = { id: 'f3', rows: ['a', 'x'] };
    // The f2 run stopped in its rows phase, so f1's rows were never removed: f3 diffs against both.
    const mid = encode({ fileId: 'f2', bases: ['f1'], phase: 'rows', n: 1 });
    const { changes } = await drain(port(v3, [v2, v1]), mid);
    expect(changes.filter((c) => c.deleted).map((c) => c.ref)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('skips a base that retention has swept', async () => {
    const { changes } = await drain(port(v2, []), 'fu1:f1:-:done:0');
    expect(changes.filter((c) => c.deleted)).toEqual([]);
  });

  it('pages removals 200 at a time', async () => {
    const big = {
      id: 'b1',
      rows: Array.from({ length: 450 }, (_, i) => `r${String(i).padStart(3, '0')}`),
    };
    const first = await definition.listChanges?.(
      ctx(port({ id: 'b2', rows: ['keep'] }, [big])),
      encode({ fileId: 'b2', bases: ['b1'], phase: 'removed', n: 0 }),
    );
    expect(first?.changes).toHaveLength(200);
    expect(first?.hasMore).toBe(true);
    expect(first?.cursor).toBe('fu1:b2:b1:removed:1');
  });

  it('treats a cursor it did not write as no cursor', async () => {
    const { changes } = await drain(port(v1), 'garbage');
    expect(changes).toHaveLength(5);
  });

  it('refuses when the connection has no file', async () => {
    await expect(definition.listChanges?.(ctx(port(null)), null)).rejects.toMatchObject({
      code: 'CONFIG',
      permanent: true,
    });
    await expect(definition.listChanges?.(ctx(), null)).rejects.toMatchObject({ code: 'CONFIG' });
  });
});

describe('cursor', () => {
  it('round-trips and rejects malformed input', () => {
    const c = { fileId: 'f2', bases: ['f1', 'f0'], phase: 'removed' as const, n: 3 };
    expect(decode(encode(c))).toEqual(c);
    expect(decode(encode({ ...c, bases: 'all' }))?.bases).toBe('all');
    for (const bad of [
      null,
      '',
      'fu2:a:-:done:0',
      'fu1:a:-:later:0',
      'fu1:a:-:done:-1',
      'fu1:a:-:done:0:x',
    ])
      expect(decode(bad)).toBeNull();
  });

  it('keeps at most 3 bases, then falls back to all', () => {
    const at = (bases: string[]) => ({ fileId: 'z', bases, phase: 'rows' as const, n: 0 });
    expect(basesFor(at(['a', 'b']))).toEqual(['a', 'b', 'z']);
    expect(basesFor(at(['a', 'b', 'c']))).toBe('all');
    expect(basesFor(null)).toBe('all');
  });
});

describe('fetchRecord and test', () => {
  it('reads the current revision only', async () => {
    const files = port(v2, [v1]);
    expect(await definition.fetchRecord(ctx(files), 'x')).toMatchObject({ status: 'ok' });
    expect(await definition.fetchRecord(ctx(files), 'b')).toEqual({ status: 'not_found' });
  });

  it('reports rows and columns', async () => {
    expect(await definition.test?.(ctx(port(v1)))).toEqual({
      ok: true,
      detail: '5 rows. Columns: id, name',
    });
  });
});
