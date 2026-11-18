import { describe, expect, it } from 'vitest';
import { applyMapping } from '@/shared/mapping/transform.ts';
import { autoMap, blankRow, fromRows, previewValue, withPinned } from './mapping.ts';

const SAMPLES = [
  '',
  ' Alex ',
  'yes',
  'y',
  'No',
  'active',
  '1',
  '0',
  'gold',
  '2024-03-05T10:20:30Z',
  '31/12/2026',
  '1700000000',
  'x',
];
const TRANSFORMS = [
  { kind: 'none' as const, options: '' },
  { kind: 'trim' as const, options: '' },
  { kind: 'upper' as const, options: '' },
  { kind: 'lower' as const, options: '' },
  { kind: 'bool-status' as const, options: '' },
  { kind: 'bool-status' as const, options: '{"true":"Member","false":"Lapsed"}' },
  { kind: 'enum' as const, options: '{"map":{"gold":"Pro"},"default":"Basic"}' },
  { kind: 'enum' as const, options: '{"map":{"gold":"Pro"}}' },
  { kind: 'constant' as const, options: '{"value":"K"}' },
  { kind: 'date' as const, options: '' },
  { kind: 'date' as const, options: '{"output":"date"}' },
  { kind: 'date' as const, options: '{"input":"dmy","output":"date"}' },
  { kind: 'date' as const, options: '{"input":"mdy","output":"iso"}' },
  { kind: 'date' as const, options: '{"input":"ymd","output":"epoch-s"}' },
];

describe('preview equals the server mapping', () => {
  for (const t of TRANSFORMS) {
    it(`${t.kind} ${t.options}`, () => {
      for (const sample of SAMPLES) {
        const row = { ...blankRow(), input: 'v', from: '/c', kind: t.kind, options: t.options };
        const { mapping } = fromRows([row]);
        const server = applyMapping(mapping, { c: sample }).v;
        const web = previewValue(row, [{ pointer: '/c', preview: sample }]);
        expect(web, JSON.stringify(sample)).toBe(server === undefined ? undefined : String(server));
      }
    });
  }
});

describe('pinned rows', () => {
  const pinned = [
    { key: 'holderEmail', label: 'Holder email', required: true },
    { key: 'externalId', label: 'External ID', required: false },
  ];
  const sources = [
    { pointer: '/E-mail', label: 'E-mail' },
    { pointer: '/Member ID', label: 'Member ID' },
  ];

  it('adds each pinned row once, first', () => {
    const rows = withPinned([{ ...blankRow(), input: 'x', from: '/a' }], pinned);
    expect(rows.map((r) => r.input)).toEqual(['holderEmail', 'externalId', 'x']);
    expect(withPinned(rows, pinned)).toHaveLength(3);
  });

  it('leaves an unmapped pinned row out of the result', () => {
    const rows = withPinned([], pinned);
    expect(fromRows(rows, pinned)).toEqual({ mapping: {}, errors: {} });
    expect(Object.keys(fromRows(rows).errors)).toHaveLength(2);
  });

  it('auto-maps into the pinned rows by header label', () => {
    const rows = autoMap(
      withPinned([], pinned),
      [
        { key: 'holderEmail', label: 'E-mail', required: true },
        { key: 'externalId', label: 'Member ID', required: false },
      ],
      sources,
    );
    expect(rows.map((r) => [r.input, r.from])).toEqual([
      ['holderEmail', '/E-mail'],
      ['externalId', '/Member ID'],
    ]);
  });
});
