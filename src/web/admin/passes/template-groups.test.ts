import { describe, expect, it } from 'vitest';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { displayName, groupTemplates } from './template-groups.ts';
import { templateSummary } from './test-fixtures.ts';

const summary = (over: Record<string, unknown>) => templateSummary(over) as TemplateSummaryDto;
const shared = (name: string, id = name) =>
  summary({ id, name, orgId: null, orgName: null, origin: 'baked' });
const own = (name: string, id = name) =>
  summary({ id, name, orgId: 'org1', orgName: 'Acme Fitness' });

describe('displayName', () => {
  it('drops a prefix that repeats the group', () => {
    expect(displayName(shared('PassBook · Generic'))).toBe('Generic');
    expect(displayName(own('Acme · Gold'))).toBe('Gold');
    expect(displayName(own('Acme Fitness · Gold'))).toBe('Gold');
  });

  it('matches curly and straight apostrophes', () => {
    const t = summary({ name: 'Joe’s · Blue', orgName: "Joe's Gym" });
    expect(displayName(t)).toBe('Blue');
  });

  it('keeps other prefixes and names without one', () => {
    expect(displayName(own('Summer · Gold'))).toBe('Summer · Gold');
    expect(displayName(own('Ac · Gold'))).toBe('Ac · Gold');
    expect(displayName(own('PassBook · Generic copy'))).toBe('PassBook · Generic copy');
    expect(displayName(shared('Acme · Gold'))).toBe('Acme · Gold');
    expect(displayName(own('Gold card'))).toBe('Gold card');
    expect(displayName(own('Acme · '))).toBe('Acme · ');
  });
});

describe('groupTemplates', () => {
  it("puts the org's own first, under its name, then Shared, in API order", () => {
    const groups = groupTemplates([
      shared('PassBook · Store card', 's1'),
      own('Acme · Gold', 'o1'),
      shared('PassBook · Coupon', 's2'),
      own('Silver', 'o2'),
    ]);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.name)])).toEqual([
      ['Acme Fitness', ['Gold', 'Silver']],
      ['Shared', ['Store card', 'Coupon']],
    ]);
  });

  it('falls back to the given org name', () => {
    const [group] = groupTemplates([summary({ orgName: null })], 'Acme Fitness');
    expect(group?.label).toBe('Acme Fitness');
  });
});
