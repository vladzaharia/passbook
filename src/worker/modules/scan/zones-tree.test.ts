import { describe, expect, it } from 'vitest';
import {
  assertPlacement,
  depthOf,
  effectiveTimeZone,
  indexZones,
  subtree,
  treeOrder,
  type ZoneNode,
} from './zones-tree.ts';

const node = (id: string, parentId: string | null, extra: Partial<ZoneNode> = {}): ZoneNode => ({
  id,
  parentId,
  timeZone: null,
  sort: 0,
  name: id,
  ...extra,
});
const rows = [
  node('root', null, { timeZone: 'Asia/Kolkata' }),
  node('a', 'root'),
  node('b', 'a'),
  node('c', 'b'),
  node('other', null),
];
const index = indexZones(rows);

describe('zone tree', () => {
  it('measures depth and inherits the root time zone', () => {
    expect(depthOf(index, 'root')).toBe(0);
    expect(depthOf(index, 'c')).toBe(3);
    expect(effectiveTimeZone(index, 'c')).toBe('Asia/Kolkata');
    expect(effectiveTimeZone(index, 'other')).toBeNull();
  });

  it('lists a zone with the zones below it, parents first', () => {
    expect(subtree(index, 'a').map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(subtree(index, 'missing')).toEqual([]);
  });

  it('refuses a cycle and a depth over three, for a new zone or a move', () => {
    const code = (fn: () => void) => {
      try {
        fn();
        return null;
      } catch (e) {
        return (e as { code: string }).code;
      }
    };
    expect(code(() => assertPlacement(index, 'a', 'c'))).toBe('ZONE_CYCLE');
    expect(code(() => assertPlacement(index, 'a', 'a'))).toBe('ZONE_CYCLE');
    expect(code(() => assertPlacement(index, 'new', 'c'))).toBe('ZONE_DEPTH');
    expect(code(() => assertPlacement(index, 'other', 'b'))).toBe(null);
    expect(code(() => assertPlacement(index, 'a', 'other'))).toBe(null);
    // `a` carries two levels below it: under `a`'s own child it would overflow, under a root it fits.
    expect(code(() => assertPlacement(indexZones([...rows, node('d', 'c')]), 'other', 'c'))).toBe(
      'ZONE_DEPTH',
    );
    expect(code(() => assertPlacement(index, 'a', null))).toBe(null);
  });

  it('orders by sort then name, children under their parent', () => {
    const ordered = treeOrder([
      node('z', null, { sort: 1, name: 'Zed' }),
      node('y', 'z', { name: 'B' }),
      node('x', 'z', { name: 'A' }),
      node('w', null, { sort: 0, name: 'Wet' }),
    ]);
    expect(ordered.map((n) => n.id)).toEqual(['w', 'z', 'x', 'y']);
    // A child whose parent is not in the list is shown as a root.
    expect(treeOrder([node('x', 'gone')]).map((n) => n.id)).toEqual(['x']);
  });
});
