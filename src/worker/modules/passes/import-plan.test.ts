import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../../passkit/types.ts';
import { parseCsv } from '../../../shared/csv/parse.ts';
import {
  columnsOf,
  headerOf,
  type ImportPlan,
  missingColumns,
  parsePlan,
  planProblems,
  pointerOfHeader,
  recordOf,
  withoutColumns,
} from './import-plan.ts';

const manifest = {
  inputs: { type: 'object', properties: { name: { type: 'string' }, points: { type: 'integer' } } },
} as unknown as TemplateManifest;

const plan = (over: Partial<ImportPlan> = {}): ImportPlan => ({
  mapping: { name: { from: '/Full name' }, points: { from: '/Points' } },
  holderEmail: { from: '/Email' },
  externalId: { from: '/Member no' },
  match: 'externalId',
  keepManual: false,
  save: true,
  ...over,
});

describe('import plan', () => {
  it('lists the columns with up to three samples and escaped pointers', () => {
    const parsed = parseCsv('Full name,a/b,Points\nAlex,1,\nSam,2,7\nKit,3,8\nLee,4,9\n');
    const columns = columnsOf(parsed);
    expect(columns.map((c) => c.pointer)).toEqual(['/Full name', '/a~1b', '/Points']);
    expect(columns[0]?.samples).toEqual(['Alex', 'Sam', 'Kit']);
    expect(columns[2]?.samples).toEqual(['7', '8', '9']);
    expect(pointerOfHeader('a~b')).toBe('/a~0b');
  });

  it('maps a header to its pointer, bare or escaped', () => {
    const header = ['Full name', 'a/b'];
    expect(headerOf('/Full name', header)).toBe('Full name');
    expect(headerOf('Full name', header)).toBe('Full name');
    expect(headerOf('/a~1b', header)).toBe('a/b');
    expect(headerOf('/Nope', header)).toBeNull();
  });

  it('builds a record of non-blank cells, safe for a __proto__ header', () => {
    const record = recordOf(['__proto__', 'x', 'y'], ['hit', ' ', ' v ']);
    expect(Object.keys(record)).toEqual(['__proto__', 'y']);
    expect(record.y).toBe('v');
    expect(({} as Record<string, unknown>).hit).toBeUndefined();
  });

  it('finds the columns a plan needs that the file lacks, constants excepted', () => {
    const p = plan({
      mapping: {
        name: { from: '', transform: { kind: 'constant', options: { value: 'x' } } },
        points: { from: '/Pts' },
      },
    });
    expect(missingColumns(p, ['Email', 'Member no'])).toEqual(['/Pts']);
    expect(missingColumns(plan(), ['Full name', 'Points', 'Email', 'Member no'])).toEqual([]);
  });

  it('drops the entries of missing columns and falls back to no matching', () => {
    const cut = withoutColumns(plan(), ['Full name', 'Email']);
    expect(Object.keys(cut.mapping)).toEqual(['name']);
    expect(cut.externalId).toBeNull();
    expect(cut.match).toBe('none');
    expect(cut.holderEmail).toEqual({ from: '/Email' });
    expect(withoutColumns(plan({ match: 'email' }), ['Email']).match).toBe('email');
  });

  it('refuses a mapping to an input the template lacks and a bad transform', () => {
    expect(planProblems(plan(), manifest)).toEqual([]);
    expect(planProblems(plan({ mapping: { nope: { from: '/A' } } }), manifest)[0]).toMatch(
      /no such input/,
    );
    expect(
      planProblems(
        plan({
          mapping: { name: { from: '/A', transform: { kind: 'date', options: { input: 'zzz' } } } },
        }),
        manifest,
      ).length,
    ).toBeGreaterThan(0);
  });

  it('reads a stored plan, or null when it no longer parses', () => {
    expect(parsePlan(JSON.stringify(plan()))?.match).toBe('externalId');
    expect(parsePlan('{"match":"x"}')).toBeNull();
    expect(parsePlan('nope')).toBeNull();
    expect(parsePlan(null)).toBeNull();
  });
});
