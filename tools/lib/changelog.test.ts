import { describe, expect, it } from 'vitest';
import {
  changelogFailures,
  coveredOps,
  hasNewVersion,
  mergePending,
  type Pending,
  stamp,
  versionedBreaks,
  versionFailures,
} from './changelog.ts';
import { type Change, changes, type Doc } from './openapi-diff.ts';

const op = (props: object, extra: object = {}) => ({
  operationId: 'a.getA',
  ...extra,
  responses: {
    200: {
      content: {
        'application/json': { schema: { type: 'object', properties: props } },
      },
    },
  },
});
const doc = (...ops: object[]): Doc => ({
  paths: Object.fromEntries(ops.map((o, i) => [i === 0 ? '/a' : `/b${i}`, { get: o }])),
});

describe('changes', () => {
  const before = doc(op({ id: { type: 'string' }, kind: { enum: ['a'] } }));

  it('classifies a new operation, a new field and a new output enum value as additive', () => {
    const after = doc(
      op({ id: { type: 'string' }, kind: { enum: ['a', 'b'] }, extra: { type: 'string' } }),
      { ...op({}), operationId: 'b.getB' },
    );
    const found = changes(before, after);
    expect(found.map((c) => [c.operationId, c.class, c.text])).toEqual([
      ['a.getA', 'notable', '200.kind: enum value "b" added'],
      ['a.getA', 'additive', '200.extra: field added'],
      ['b.getB', 'additive', 'new operation'],
    ]);
  });

  it('classifies a removed field as breaking, tied to its operation', () => {
    const found = changes(before, doc(op({ kind: { enum: ['a'] } })));
    expect(found).toEqual([
      { operationId: 'a.getA', op: 'GET /a', class: 'breaking', text: '200.id: field removed' },
    ]);
  });

  it('reports a new deprecation and an optional parameter, never a required one as additive', () => {
    const withParams = (required: boolean) =>
      doc(
        op(
          { id: { type: 'string' }, kind: { enum: ['a'] } },
          {
            deprecated: true,
            parameters: [{ in: 'query', name: 'q', required, schema: { type: 'string' } }],
          },
        ),
      );
    const optional = changes(before, withParams(false)).map((c) => c.text);
    expect(optional).toEqual(['optional parameter query:q added', 'deprecated']);
    expect(changes(before, withParams(true)).map((c) => c.class)).not.toContain('additive');
  });

  it('is empty for an identical document', () => {
    expect(changes(before, structuredClone(before))).toEqual([]);
  });
});

describe('changelog notes', () => {
  const change: Change = {
    operationId: 'a.getA',
    op: 'GET /a',
    class: 'additive',
    text: 'new operation',
  };

  it('fails a change missing from unreleased.json and an entry with no note', () => {
    expect(changelogFailures([], [change])).toEqual([
      'GET /a new operation: not in unreleased.json; run npm run gen',
    ]);
    const merged = mergePending([], [change]);
    expect(changelogFailures(merged, [change])).toEqual([
      'GET /a new operation: needs a one-line note in unreleased.json',
    ]);
  });

  it('passes once the note is written, and a regenerate keeps it', () => {
    const [entry] = mergePending([], [change]);
    const noted = [{ ...(entry as NonNullable<typeof entry>), note: 'List a things.' }];
    expect(changelogFailures(noted, [change])).toEqual([]);
    expect(mergePending(noted, [change])).toEqual(noted);
    expect(mergePending(noted, [])).toEqual(noted);
  });

  it('refuses a note that is not one line', () => {
    const [entry] = mergePending([], [change]);
    const bad = [{ ...(entry as NonNullable<typeof entry>), note: 'a\nb' }];
    expect(changelogFailures(bad, [change])[0]).toMatch(/one line/);
  });

  it('stamps notes into a dated file and refuses while one is missing', () => {
    const [entry] = mergePending([], [change]);
    const e = entry as NonNullable<typeof entry>;
    expect(() => stamp([e], '2026-12-01')).toThrow(/Notes missing/);
    expect(stamp([{ ...e, note: 'List a things.' }], '2026-12-01')).toEqual({
      date: '2026-12-01',
      entries: [{ kind: 'Added', text: 'List a things.', ops: ['a.getA'] }],
    });
  });

  it('exempts only operations a covering entry names', () => {
    expect(
      coveredOps([
        {
          date: 'd',
          entries: [
            { kind: 'Added', text: 'x', ops: ['a'], covers: true },
            { kind: 'Added', text: 'y', ops: ['b'] },
          ],
        },
      ]),
    ).toEqual(new Set(['a']));
  });
});

describe('versions', () => {
  const v = (date: string, migration = 'Send the header.') => ({ date, summary: 's', migration });
  it('needs a migration note, and a version is never removed', () => {
    expect(versionFailures({ versions: [v('2026-11-20', ' ')] }, null)).toEqual([
      'versions.json: 2026-11-20 needs a migration note',
    ]);
    expect(versionFailures({ versions: [] }, { versions: [v('2026-11-20')] })).toEqual([
      'versions.json: 2026-11-20 was removed',
    ]);
  });
  it('a breaking change needs a version the base lacks', () => {
    expect(hasNewVersion({ versions: [v('2026-11-20')] }, null)).toBe(true);
    expect(hasNewVersion({ versions: [v('2026-11-20')] }, { versions: [v('2026-11-20')] })).toBe(
      false,
    );
  });
  it('an unversioned entry covers only a request-side tightening', () => {
    const pending = [
      {
        key: 'POST /a body.t: unknown keys now refused',
        change: 'body.t: unknown keys now refused',
        unversioned: true,
      },
      { key: 'POST /a body.u: field removed', change: 'body.u: field removed' },
      { key: 'GET /b 200.x: field removed', change: '200.x: field removed', unversioned: true },
    ] as Pending[];
    expect(
      versionedBreaks(
        [
          'POST /a body.t: unknown keys now refused',
          'POST /a body.u: field removed',
          'GET /b 200.x: field removed',
        ],
        pending,
      ),
    ).toEqual(['POST /a body.u: field removed', 'GET /b 200.x: field removed']);
  });
});

describe('versionedBreaks at a Sunset', () => {
  it('lets a removal at the Sunset through without a version, and keeps the rest', () => {
    expect(
      versionedBreaks(
        [
          'GET /a: operation removed at its Sunset 2027-11-25',
          'GET /b: operation removed before its Sunset 2027-11-25',
          'GET /c: operation removed',
        ],
        [],
      ),
    ).toEqual([
      'GET /b: operation removed before its Sunset 2027-11-25',
      'GET /c: operation removed',
    ]);
  });
});
