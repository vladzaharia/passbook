import { describe, expect, it } from 'vitest';
import { decodeCursor } from './cursor.ts';
import { harness } from './harness.ts';
import connector from './index.ts';

const v1Base = {
  baseUrl: 'https://api.example.com/v1',
  recordPath: '/{ref}',
  recordPointer: '',
  auth: { type: 'header', headerName: 'X-Key' },
  webhook: {
    eventIdPointer: '/id',
    refsPointer: '/refs',
    signatureHeader: 'x-wallet-signature',
    timestampHeader: 'x-wallet-timestamp',
  },
};
const v1List = {
  path: '/members/changes',
  cursorParam: 'since_id',
  cursorPointer: '/next',
  itemsPointer: '/rows',
  refPointer: '/uid',
  recordPointer: '/fields',
  deletedPointer: '/gone',
};

describe('http-json migrate (v1 to v2)', () => {
  const migrate = (stored: unknown) =>
    connector.migrate?.(1, stored) as ReturnType<typeof connector.configSchema.parse>;

  it('maps a v1 list to a feed with body-cursor pagination', () => {
    const c = migrate({ ...v1Base, list: v1List });
    expect(c.list).toMatchObject({
      path: '/members/changes',
      listing: 'feed',
      recordsPointer: '/rows',
      idPointer: '/uid',
      recordPointer: '/fields',
      deletedPointer: '/gone',
      pagination: { style: 'cursor', param: 'since_id', cursorPointer: '/next', from: 'body' },
    });
    expect(c.list?.pagination).not.toHaveProperty('hasMorePointer');
    expect(c.list?.incremental).toBeUndefined();
    expect(c).toMatchObject({ baseUrl: v1Base.baseUrl, recordPath: '/{ref}', auth: v1Base.auth });
  });

  it('carries hasMorePointer, the webhook block and the record path over', () => {
    const c = migrate({ ...v1Base, list: { ...v1List, hasMorePointer: '/more' } });
    expect(c.list?.pagination).toMatchObject({ hasMorePointer: '/more' });
    expect(c.webhook).toEqual(v1Base.webhook);
  });

  it('migrates a v1 config without a list, and leaves a v2 config alone', () => {
    const none = migrate(v1Base);
    expect(none.list).toBeUndefined();
    expect(none.recordPath).toBe('/{ref}');
    const v2 = connector.configSchema.parse({
      baseUrl: 'https://api.example.com',
      list: { path: '/l', pagination: { style: 'offset', size: 50 } },
    });
    expect(connector.migrate?.(2, v2)).toEqual(v2);
    expect(connector.configSchema.parse(migrate({ ...v1Base, list: v1List }))).toEqual(
      migrate({ ...v1Base, list: v1List }),
    );
  });

  // The v1 rule: more = hasMorePointer ? flag === true : next !== null && next !== cursor;
  // hasMore = more && next !== null; the stored cursor is next ?? cursor ?? ''.
  // v2 differs in one case only: a repeated cursor stops even when the flag says more, which in v1 looped.
  it.each([
    // [hasMorePointer, flag, next, cursor, hasMore, saved]
    [false, undefined, 'n2', 'n1', true, 'n2'],
    [false, undefined, 'n1', 'n1', false, 'n1'],
    [false, undefined, undefined, 'n1', false, 'n1'],
    [false, undefined, '', 'n1', false, 'n1'],
    [true, true, 'n2', 'n1', true, 'n2'],
    [true, false, 'n2', 'n1', false, 'n2'],
    [true, true, undefined, 'n1', false, 'n1'],
    [true, true, 'n1', 'n1', false, 'n1'],
  ])(
    'keeps the v1 has-more rule (pointer %s, flag %s, next %s, cursor %s)',
    async (pointer, flag, next, cursor, hasMore, saved) => {
      const c = migrate({
        ...v1Base,
        auth: { type: 'none' },
        list: {
          path: '/l',
          cursorParam: 'cursor',
          cursorPointer: '/cursor',
          itemsPointer: '/items',
          refPointer: '/id',
          recordPointer: '',
          ...(pointer ? { hasMorePointer: '/more' } : {}),
        },
      });
      const { ctx } = harness(c, {}, () => ({
        body: { items: [{ id: 'a' }], cursor: next, more: flag },
      }));
      const res = await connector.listChanges?.(ctx, cursor);
      expect(res?.hasMore).toBe(hasMore);
      expect(decodeCursor(res?.cursor ?? null).state.p?.c).toBe(saved);
    },
  );
});
