import { describe, expect, it } from 'vitest';
import { filterRefusal, filterSelection, targetOf } from './selection.ts';

describe('filter selection', () => {
  it('runs a template filter with the filters a run reads', () => {
    const s = filterSelection(
      { templateId: 't1', q: 'ann', onDevice: true, status: 'active' },
      ['t1'],
      1240,
    );
    expect(s).not.toBeNull();
    expect(s && targetOf(s)).toEqual({ templateIds: ['t1'], q: 'ann', onDevice: true });
  });

  it('runs an import filter as the import with the list filters kept', () => {
    const s = filterSelection({ importId: 'i1', q: 'x' }, ['t1'], 5);
    expect(s && targetOf(s)).toEqual({ importId: 'i1', q: 'x' });
  });

  it('never guesses the template from the rows on screen', () => {
    expect(filterSelection({ q: 'a' }, ['t9'], 3)).toBeNull();
    expect(filterSelection({ importId: 'i1' }, [], 3)).toBeNull();
    expect(filterRefusal({ q: 'a' })).toBe('Filter by one template to change all matching.');
  });

  it('refuses what a run cannot read', () => {
    expect(filterSelection({ templateId: 't', connectionId: 'c' }, ['t'], 1)).toBeNull();
    expect(filterSelection({ templateId: 't', holderEmail: 'a@b.co' }, ['t'], 1)).toBeNull();
    expect(filterSelection({ templateId: 't', status: 'voided' }, ['t'], 1)).toBeNull();
    expect(
      filterSelection(
        { templateId: 't', match: [{ input: 'a', op: 'contains', value: 'x' }] },
        ['t'],
        1,
      ),
    ).toBeNull();
  });
});
