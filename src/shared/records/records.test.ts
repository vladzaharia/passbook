import { describe, expect, it } from 'vitest';
import { detectRecordsArray, detectRecordsArrays, idCandidates, timeCandidates } from './detect.ts';
import { leafFields, resolvePointer } from './fields.ts';

describe('leafFields', () => {
  const rows = [
    {
      id: 'a1',
      user: { email: 'a@x.test', 'a/b': 1 },
      born: '2020-01-02',
      at: '2024-05-06T07:08:09Z',
      tags: ['x'],
      note: '',
    },
    {
      id: 'a2',
      user: { email: 'b@x.test', 'a/b': 2 },
      born: '2021-01-02',
      at: '2024-05-07T07:08:09Z',
      tags: [],
      note: null,
    },
  ];
  const f = Object.fromEntries(leafFields(rows).map((x) => [x.pointer, x]));

  it('flattens to pointers with types', () => {
    expect(Object.keys(f)).toEqual([
      '/id',
      '/user/email',
      '/user/a~1b',
      '/born',
      '/at',
      '/tags',
      '/note',
    ]);
    expect(f['/id']).toMatchObject({ type: 'string', unique: true, filled: 2, name: 'id' });
    expect(f['/user/a~1b']).toMatchObject({ type: 'number', numMin: 1, numMax: 2, name: 'a/b' });
    expect(f['/born']?.type).toBe('date');
    expect(f['/at']?.type).toBe('datetime');
    expect(f['/tags']?.type).toBe('array');
    expect(f['/note']).toMatchObject({ type: 'null', filled: 0, unique: false });
  });

  it('finds id and time candidates', () => {
    expect(idCandidates(Object.values(f))[0]?.pointer).toBe('/id');
    expect(timeCandidates(Object.values(f)).map((x) => x.pointer)).toEqual(['/at', '/born']);
  });

  it('spots epoch numbers by name and range', () => {
    const t = leafFields([
      { updated_at: 1_700_000_000 },
      { updated_at: 1_700_000_100 },
      { qty: 1_700_000_000 },
    ]);
    expect(timeCandidates(t).map((x) => x.pointer)).toEqual(['/updated_at']);
    const ms = leafFields([{ created: 1_700_000_000_000 }]);
    expect(timeCandidates(ms)).toHaveLength(1);
  });

  it('ranks id-like names first and rejects duplicates', () => {
    const t = leafFields([
      { n: 1, ticket_id: 'a', email: 'x' },
      { n: 2, ticket_id: 'b', email: 'y' },
      { n: 3, ticket_id: 'b', email: 'z' },
    ]);
    expect(idCandidates(t).map((x) => x.pointer)).toEqual(['/email', '/n']);
  });
});

describe('detectRecordsArray', () => {
  it('prefers a root array, then hinted names, then length', () => {
    expect(detectRecordsArray([{ a: 1 }])).toMatchObject({ pointer: '' });
    const doc = {
      included: [{ a: 1 }, { a: 2 }, { a: 3 }],
      data: [{ a: 1 }],
      meta: { rows: [{ x: 1 }] },
    };
    expect(detectRecordsArrays(doc).map((c) => c.pointer)).toEqual([
      '/data',
      '/meta/rows',
      '/included',
    ]);
    expect(detectRecordsArray({ a: [1, 2], b: 'x' })).toBeNull();
    expect(detectRecordsArray({ people: [{ n: 1 }, { n: 2 }], tags: [{ t: 1 }] })?.pointer).toBe(
      '/people',
    );
  });

  it('does not look into arrays or past three levels', () => {
    expect(detectRecordsArray({ a: [[{ x: 1 }]] })).toBeNull();
    expect(detectRecordsArray({ a: { b: { c: { d: [{ x: 1 }] } } } })).toBeNull();
    expect(detectRecordsArray({ a: { b: { c: [{ x: 1 }] } } })?.pointer).toBe('/a/b/c');
  });
});

describe('resolvePointer', () => {
  it('walks objects and arrays and unescapes tokens', () => {
    const doc = { 'a/b': { c: [10, 20] } };
    expect(resolvePointer(doc, '/a~1b/c/1')).toEqual({ found: true, value: 20 });
    expect(resolvePointer(doc, '/a~1b/c/2')).toEqual({ found: false });
    expect(resolvePointer(doc, '/toString')).toEqual({ found: false });
    expect(resolvePointer(doc, 'x')).toEqual({ found: false });
    expect(resolvePointer(doc, '')).toEqual({ found: true, value: doc });
  });
});
