import { describe, expect, it } from 'vitest';
import type { ConnectorContext } from '../types.ts';
import connector from './index.ts';

type Cfg = ReturnType<typeof connector.configSchema.parse>;

function ctx(config: Record<string, unknown> = {}): ConnectorContext<Cfg, undefined> {
  return {
    connection: {
      id: 'c',
      orgId: 'o',
      generation: 1,
      config: connector.configSchema.parse(config),
    },
    secrets: undefined,
    now: () => 0,
    fetch: async () => {
      throw new Error('demo must not fetch');
    },
    signal: new AbortController().signal,
    log: () => {},
  };
}

async function listAll(c: ConnectorContext<Cfg, undefined>) {
  const changes = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const page: Awaited<ReturnType<NonNullable<typeof connector.listChanges>>> | undefined =
      await connector.listChanges?.(c, cursor);
    if (!page) throw new Error('no listChanges');
    changes.push(...page.changes);
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  return { changes, cursor };
}

describe('demo connector', () => {
  it('is deterministic per seed and ref', async () => {
    const a = await connector.fetchRecord(ctx({ seed: 's1' }), 'm-001');
    const b = await connector.fetchRecord(ctx({ seed: 's1' }), 'm-001');
    const other = await connector.fetchRecord(ctx({ seed: 's2' }), 'm-001');
    expect(a).toEqual(b);
    expect(a).not.toEqual(other);
    expect(a.status === 'ok' && a.holderEmail).toBe('m-001@example.com');
  });

  it('changes records when the revision is raised', async () => {
    const r0 = await connector.fetchRecord(ctx({ revision: 0 }), 'm-002');
    const r1 = await connector.fetchRecord(ctx({ revision: 3 }), 'm-002');
    if (r0.status !== 'ok' || r1.status !== 'ok') throw new Error('expected ok');
    expect(Number(r1.record.points) - Number(r0.record.points)).toBe(30);
  });

  it('reports missing and unknown refs as not found', async () => {
    expect(await connector.fetchRecord(ctx({ missing: ['m-001'] }), 'm-001')).toEqual({
      status: 'not_found',
    });
    expect(await connector.fetchRecord(ctx({ count: 2 }), 'm-009')).toEqual({
      status: 'not_found',
    });
  });

  it('lists every record over several pages, then nothing at the same revision', async () => {
    const c = ctx({ count: 25, missing: ['m-003'] });
    const first = await listAll(c);
    expect(first.changes).toHaveLength(25);
    expect(first.changes.find((x) => x.ref === 'm-003')).toEqual({ ref: 'm-003', deleted: true });
    const again = await connector.listChanges?.(c, first.cursor);
    expect(again?.changes).toEqual([]);
    expect(again?.hasMore).toBe(false);
  });

  it('restarts the listing when the revision changes', async () => {
    const before = await listAll(ctx({ count: 12 }));
    const after = await connector.listChanges?.(ctx({ count: 12, revision: 1 }), before.cursor);
    expect(after?.changes).toHaveLength(10);
  });

  it.each([
    ['auth', 'AUTH'],
    ['timeout', 'TIMEOUT'],
    ['upstream', 'UPSTREAM'],
    ['rate_limited', 'RATE_LIMITED'],
  ])('simulates %s failures on every call', async (fail, code) => {
    const c = ctx({ fail });
    await expect(connector.fetchRecord(c, 'm-001')).rejects.toMatchObject({ code });
    await expect(connector.listChanges?.(c, null)).rejects.toMatchObject({ code });
    await expect(connector.test?.(c)).rejects.toMatchObject({ code });
  });
});
