import { describe, expect, it } from 'vitest';
import { PassMatchSchema } from './broadcasts.ts';
import { ChangeRunTargetSchema, PatchOpSchema } from './broadcasts-change.ts';
import { PassImportEmailSendSchema, PassImportPlanV2Schema } from './pass-imports.ts';
import { PassSelectionSchema, selectionDrifted } from './pass-selection.ts';

const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('PlanV2', () => {
  const plan = { mapping: {}, holderEmail: null, externalId: null, match: 'none' };

  it('takes a join and up to 200 overrides', () => {
    const join = { from: '/First', transform: { kind: 'join', options: { with: ['/Last'] } } };
    expect(PassImportPlanV2Schema.safeParse({ ...plan, mapping: { name: join } }).success).toBe(
      true,
    );
    const cells = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [String(i + 2), { '/Plan': 'Annual' }]),
      );
    expect(PassImportPlanV2Schema.safeParse({ ...plan, overrides: cells(200) }).success).toBe(true);
    expect(PassImportPlanV2Schema.safeParse({ ...plan, overrides: cells(201) }).success).toBe(
      false,
    );
  });

  it.each([60_000, 300_000, 900_000, 3_600_000, 14_400_000, 86_400_000])(
    'accepts a hold of %d ms',
    (holdMs) => {
      expect(PassImportEmailSendSchema.safeParse({ send: 'held', holdMs }).success).toBe(true);
    },
  );

  it.each([59_999, 86_400_001])('refuses a hold of %d ms', (holdMs) => {
    expect(PassImportEmailSendSchema.safeParse({ send: 'held', holdMs }).success).toBe(false);
  });

  it('holds email for 5 minutes by default', () => {
    expect(PassImportEmailSendSchema.parse({ send: 'held' })).toEqual({
      send: 'held',
      holdMs: 300_000,
    });
  });
});

describe('change runs', () => {
  it('target exactly one of templates, pass ids or an import', () => {
    expect(ChangeRunTargetSchema.safeParse({ passIds: [id], expectCount: 1 }).success).toBe(true);
    expect(ChangeRunTargetSchema.safeParse({ importId: id }).success).toBe(true);
    expect(ChangeRunTargetSchema.safeParse({ templateIds: [id], importId: id }).success).toBe(
      false,
    );
    expect(ChangeRunTargetSchema.safeParse({}).success).toBe(false);
  });

  it('take set, clear, shift and add ops', () => {
    for (const op of [
      { set: 'annual' },
      { clear: true },
      { shift: 'P1Y' },
      { shift: '-P7D' },
      { add: 2 },
    ])
      expect(PatchOpSchema.safeParse(op).success).toBe(true);
    for (const op of [{ shift: 'P' }, { shift: '1 year' }, { set: 1, add: 1 }])
      expect(PatchOpSchema.safeParse(op).success).toBe(false);
  });
});

describe('pass selection', () => {
  it('is ids or a filter with the count seen', () => {
    expect(PassSelectionSchema.safeParse({ ids: [id] }).success).toBe(true);
    expect(
      PassSelectionSchema.safeParse({
        filter: { templateId: id, match: [{ input: 'memberId', op: 'startsWith', value: 'M-20' }] },
        expectCount: 1240,
      }).success,
    ).toBe(true);
    expect(PassSelectionSchema.safeParse({ filter: {} }).success).toBe(false);
  });

  it('matches up to five clauses', () => {
    const clause = { input: 'memberName', op: 'contains', value: 'kai' };
    expect(PassMatchSchema.safeParse(Array(5).fill(clause)).success).toBe(true);
    expect(PassMatchSchema.safeParse(Array(6).fill(clause)).success).toBe(false);
  });

  it('refuses any drift', () => {
    expect(selectionDrifted(1000, 1000)).toBe(false);
    expect(selectionDrifted(1000, 1001)).toBe(true);
    expect(selectionDrifted(10, 9)).toBe(true);
  });
});
