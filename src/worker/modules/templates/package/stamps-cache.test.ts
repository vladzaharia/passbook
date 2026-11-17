import { describe, expect, it } from 'vitest';
import { byteLru } from './stamps-cache.ts';

describe('byteLru', () => {
  const lru = () => byteLru<number>(100, (n) => n);

  it('evicts the least recently used past the byte limit', () => {
    const c = lru();
    c.set('a', 40);
    c.set('b', 40);
    expect(c.get('a')).toBe(40);
    c.set('c', 40);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(40);
    expect(c.get('c')).toBe(40);
    expect(c.bytes).toBe(80);
  });

  it('never holds an entry larger than the limit and replaces by key', () => {
    const c = lru();
    c.set('big', 101);
    expect(c.size).toBe(0);
    c.set('a', 60);
    c.set('a', 30);
    expect(c.bytes).toBe(30);
  });
});
