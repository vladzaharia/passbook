import { describe, expect, it } from 'vitest';
import { exampleBody } from './payload-example.ts';

describe('exampleBody', () => {
  it('draws the default shape', () => {
    expect(JSON.parse(exampleBody({}))).toEqual({
      id: 'evt-1',
      records: [{ ref: 'm-001', record: { name: 'Maya Chen' }, deleted: false }],
    });
  });

  it('follows the pointers, nested ones included', () => {
    const body = JSON.parse(
      exampleBody({
        recordsPointer: '/data/items',
        refPointer: '/key',
        recordPointer: '/attrs',
        deletedPointer: '/gone',
        eventIdPointer: '/meta/event',
      }),
    );
    expect(body).toEqual({
      meta: { event: 'evt-1' },
      data: { items: [{ key: 'm-001', attrs: { name: 'Maya Chen' }, gone: false }] },
    });
  });

  it('never writes through a prototype key', () => {
    exampleBody({ recordsPointer: '/__proto__/polluted' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
