import { describe, expect, it } from 'vitest';
import {
  CheckPassImportSchema,
  CreatePassImportSchema,
  PASS_IMPORT_MAX_BYTES,
  PassImportCommitSchema,
  PassImportPlanSchema,
  PassImportRemoveSchema,
} from './pass-imports.ts';

const plan = {
  mapping: { points: { from: '/Points' } },
  holderEmail: { from: '/Email' },
  externalId: { from: '/Member ID' },
  match: 'externalId',
};
const file = { kind: 'file', name: 'members.csv', csv: 'a,b\n1,2' };

describe('pass import contracts', () => {
  it('parses a plan and applies the defaults', () => {
    expect(PassImportPlanSchema.parse(plan)).toMatchObject({ keepManual: false, save: true });
    expect(PassImportCommitSchema.parse({})).toEqual({ skipInvalid: false, email: false });
  });

  it('refuses a match on a column that is not mapped', () => {
    expect(PassImportPlanSchema.safeParse({ ...plan, externalId: null }).success).toBe(false);
    expect(
      PassImportPlanSchema.safeParse({ ...plan, match: 'email', holderEmail: null }).success,
    ).toBe(false);
    expect(
      PassImportPlanSchema.safeParse({
        ...plan,
        match: 'none',
        externalId: null,
        holderEmail: null,
      }).success,
    ).toBe(true);
    expect(PassImportPlanSchema.safeParse({ ...plan, match: 'name' }).success).toBe(false);
  });

  it('refuses unknown keys', () => {
    expect(PassImportPlanSchema.safeParse({ ...plan, extra: 1 }).success).toBe(false);
    expect(
      CreatePassImportSchema.safeParse({ templateId: 't', source: file, orgId: 'o' }).success,
    ).toBe(false);
    expect(PassImportCommitSchema.safeParse({ email: true, send: 1 }).success).toBe(false);
  });

  it('takes a file or an https link, with an optional plan', () => {
    expect(CreatePassImportSchema.safeParse({ templateId: 't', source: file }).success).toBe(true);
    const url = (u: string) =>
      CreatePassImportSchema.safeParse({ templateId: 't', source: { kind: 'url', url: u }, plan })
        .success;
    expect(url('https://docs.google.com/spreadsheets/d/e/x/pub?output=csv')).toBe(true);
    expect(url('http://example.com/a.csv')).toBe(false);
    expect(url('not a url')).toBe(false);
  });

  it('refuses an empty or oversize file', () => {
    const create = (source: unknown) =>
      CreatePassImportSchema.safeParse({ templateId: 't', source }).success;
    expect(create({ ...file, csv: '' })).toBe(false);
    expect(create({ ...file, csv: 'x'.repeat(PASS_IMPORT_MAX_BYTES + 1) })).toBe(false);
    expect(create({ ...file, name: '' })).toBe(false);
    expect(create({ kind: 'sheet', url: 'https://x.test' })).toBe(false);
  });

  it('needs a plan to check, and a nullable cursor to remove', () => {
    expect(CheckPassImportSchema.safeParse({}).success).toBe(false);
    expect(CheckPassImportSchema.safeParse({ plan }).success).toBe(true);
    expect(PassImportRemoveSchema.safeParse({ cursor: null }).success).toBe(true);
    expect(PassImportRemoveSchema.safeParse({}).success).toBe(false);
  });
});
