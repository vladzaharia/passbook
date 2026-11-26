import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ConnectionFileSchema } from '@/shared/contracts/connection-files.ts';
import { checksOf } from './file-checks.tsx';
import { draftFile } from './files-fixtures.ts';

const file = (over: Record<string, unknown> = {}) =>
  draftFile(over) as unknown as z.infer<typeof ConnectionFileSchema>;
const ids = (f: ReturnType<typeof file>, id: string) => checksOf(f, id).find((c) => c.id === 'id');

describe('checksOf', () => {
  it('passes a unique ID column', () => {
    expect(ids(file(), '/Member ID')).toMatchObject({ state: 'done' });
  });

  it('warns about rows an ID column skips, and says why', () => {
    const f = file();
    f.columns[0] = { ...f.columns[0]!, blanks: 3, duplicates: 2 };
    expect(ids(f, '/Member ID')).toMatchObject({
      state: 'invalid',
      label: '5 rows skipped',
      detail: '3 with no ID, 2 repeating one',
    });
  });

  it('fails when no row has a usable ID', () => {
    const f = file({ rows: 4 });
    f.columns[1] = { ...f.columns[1]!, blanks: 4 };
    expect(ids(f, '/Name')).toMatchObject({ state: 'failed' });
  });

  it('asks for a column before one is chosen', () => {
    expect(ids(file(), '')).toMatchObject({ state: 'invalid' });
  });
});
