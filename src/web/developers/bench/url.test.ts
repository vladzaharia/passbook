import { afterEach, describe, expect, it } from 'vitest';
import { filtersInUrl, selectedId, selectInUrl, setFiltersInUrl } from './url.ts';

afterEach(() => history.replaceState(null, '', '/'));

describe('the bench address', () => {
  it('keeps the selection in the hash and the filters in the query, each without the other moving', () => {
    history.replaceState(null, '', '/developers/logs?status=4xx#req-1');
    const before = history.length;
    expect(selectedId()).toBe('req-1');
    expect(filtersInUrl()).toEqual({ status: '4xx' });
    selectInUrl('req 2');
    expect(location.search).toBe('?status=4xx');
    expect(selectedId()).toBe('req 2');
    setFiltersInUrl({ key: 'k1', status: null });
    expect(filtersInUrl()).toEqual({ key: 'k1' });
    expect(selectedId()).toBe('req 2');
    selectInUrl(null);
    expect(location.href).toBe('http://localhost:5173/developers/logs?key=k1');
    // In place: Back steps through tools, not picks.
    expect(history.length).toBe(before);
  });

  it('leaves a tool\u2019s own tail after ? out of the id', () => {
    expect(selectedId('#passes.getPasses?body=%7B%7D&q.limit=5')).toBe('passes.getPasses');
    expect(selectedId('#a%3Fb')).toBe('a?b');
  });

  it('reads no selection from an empty hash', () => {
    expect(selectedId('')).toBeNull();
    expect(selectedId('#')).toBeNull();
  });
});
