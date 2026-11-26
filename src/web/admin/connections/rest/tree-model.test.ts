import { describe, expect, it } from 'vitest';
import { actionsFor } from './explorer-actions.ts';
import { ancestors, buildRows, defaultOpen } from './tree-model.ts';

const body = {
  data: [
    { id: 'm_1', email: 'a@x.com', at: 1_700_000_000_000 },
    { id: 'm_2', email: 'b@x.com', at: 1_700_000_001_000 },
  ],
  meta: { next: 'abc', more: true, pages: 4 },
};

describe('response tree rows', () => {
  it('opens the way to the records and the first record', () => {
    const rows = buildRows(body, defaultOpen('/data'), new Map([['/data', 312]]));
    const keys = rows.map((r) => r.pointer);
    expect(keys).toContain('/data/0/email');
    expect(keys).not.toContain('/data/1/email');
    const data = rows.find((r) => r.pointer === '/data');
    expect(data).toMatchObject({ kind: 'array', count: 2, total: 312, records: true, depth: 2 });
    const email = rows.find((r) => r.pointer === '/data/0/email');
    expect(email).toMatchObject({ depth: 4, setSize: 3, posInSet: 2, parent: '/data/0' });
  });

  it('lists the nodes above a pointer', () => {
    expect(ancestors('/data/0/email')).toEqual(['', '/data', '/data/0']);
  });
});

describe('what a node can be used as', () => {
  const rows = buildRows(body, new Set(['', '/data', '/data/0', '/meta']), new Map());
  const at = (p: string) => {
    const row = rows.find((r) => r.pointer === p);
    if (!row) throw new Error(p);
    return row;
  };
  const labels = (p: string, v = {}) => actionsFor(at(p), '/data', v).map((a) => a.label);

  it('offers the records on a list of objects', () => {
    expect(labels('/data')).toEqual(['Use as records']);
  });

  it('offers the field roles inside a record, relative to it', () => {
    const [id, updated, email] = actionsFor(at('/data/0/email'), '/data', {});
    expect(id?.effect.patch).toEqual({ 'list.idPointer': '/email' });
    expect(updated?.effect.updated).toEqual({ field: '/email', format: 'iso' });
    expect(email?.effect.patch).toEqual({ holderEmailPointer: '/email' });
    expect(actionsFor(at('/data/0/at'), '/data', {})[1]?.effect.updated?.format).toBe('unix-ms');
  });

  it('offers paging roles outside the records', () => {
    expect(labels('/meta/next')).toEqual(['Use as next cursor', 'Use as next link']);
    expect(labels('/meta/more')).toContain('Use as has-more flag');
    const total = actionsFor(at('/meta/pages'), '/data', {}).find((a) => a.id === 'total');
    expect(total?.label).toBe('Use as total pages');
    expect(total?.effect.patch?.['list.pagination']).toMatchObject({
      style: 'page',
      totalPagesPointer: '/meta/pages',
    });
  });

  it('keeps the cursor settings when the has-more flag is picked', () => {
    const v = {
      'list.pagination': {
        style: 'cursor',
        param: 'after',
        cursorPointer: '/meta/next',
        from: 'body',
      },
    };
    const more = actionsFor(at('/meta/more'), '/data', v).find((a) => a.id === 'has-more');
    expect(more?.effect.patch?.['list.pagination']).toEqual({
      style: 'cursor',
      param: 'after',
      cursorPointer: '/meta/next',
      from: 'body',
      hasMorePointer: '/meta/more',
    });
  });
});
