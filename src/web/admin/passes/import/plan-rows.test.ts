import { describe, expect, it } from 'vitest';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { importDto, PLAN } from './import-test-fixtures.ts';
import { planOfRows, rowsOfImport } from './plan-rows.ts';
import { fileProblem } from './source-step.tsx';

const targets = [
  { key: 'name', label: 'Member name', required: true },
  { key: 'level', label: 'Level', required: false, values: ['copper', 'blue'] },
];
const imp = (over: Record<string, unknown> = {}) => importDto(over) as unknown as PassImportDto;
const SETTINGS = { match: 'externalId', keepManual: false, save: true } as const;

describe('plan rows', () => {
  it('maps columns by name when there is no saved plan, pinned rows first', () => {
    const rows = rowsOfImport(imp(), targets);
    expect(rows.map((r) => [r.input, r.from])).toEqual([
      ['$holderEmail', '/Email'],
      ['$externalId', '/Id'],
      ['name', '/Name'],
      ['level', '/Level'],
    ]);
  });

  it('opens a saved plan as it was saved', () => {
    const rows = rowsOfImport(imp({ plan: PLAN }), targets);
    expect(rows.map((r) => [r.input, r.from])).toEqual([
      ['$holderEmail', '/Email'],
      ['$externalId', '/Id'],
      ['name', '/Name'],
    ]);
  });

  it('builds the API plan: pinned rows become their own fields', () => {
    const { plan } = planOfRows(rowsOfImport(imp(), targets), SETTINGS);
    expect(plan).toEqual({
      mapping: { name: { from: '/Name' }, level: { from: '/Level' } },
      holderEmail: { from: '/Email' },
      externalId: { from: '/Id' },
      match: 'externalId',
      keepManual: false,
      save: true,
    });
  });

  it('refuses a match on a column that is not mapped, and never keeps edits without a match', () => {
    const rows = rowsOfImport(
      imp({ columns: [{ pointer: '/Name', label: 'Name', samples: [] }] }),
      targets,
    );
    expect(planOfRows(rows, SETTINGS).matchError).toBe(C.match.needExternalId);
    expect(planOfRows(rows, { ...SETTINGS, match: 'email' }).matchError).toBe(C.match.needEmail);
    const none = planOfRows(rowsOfImport(imp(), targets), {
      match: 'none',
      keepManual: true,
      save: true,
    });
    expect(none.plan?.keepManual).toBe(false);
  });

  it('checks the file before it is read', () => {
    expect(fileProblem({ name: 'a.xlsx', size: 1 })).toBe(C.xlsx);
    expect(fileProblem({ name: 'a.pdf', size: 1 })).toBe(C.notCsv);
    expect(fileProblem({ name: 'a.CSV', size: 3_000_000 })).toBe(C.tooBig);
    expect(fileProblem({ name: 'a.tsv', size: 10 })).toBeNull();
  });

  it('words the counts and the commit button', () => {
    expect(C.countsLine({ create: 1, update: 0, unchanged: 0, errors: 1 })).toBe(
      '1 to create · 0 to update · 0 unchanged · 1 error',
    );
    expect(C.commitLabel(120, 40)).toBe('Create 120 and update 40');
    expect(C.commitLabel(0, 4)).toBe('Update 4');
    expect(C.commitLabel(3, 0)).toBe('Create 3');
  });
});
