import { describe, expect, it } from 'vitest';
import { builtPreviews } from '../../playground/test-data.ts';
import { anonBlueprint } from './blueprint.ts';
import { livePass } from './live-plan.ts';

const { data } = builtPreviews();

describe('live plan', () => {
  it('rebuilds every stored card from its own sample', () => {
    for (const item of data.items)
      expect(livePass(anonBlueprint(item), item.sample), item.id).toEqual(item.passJson);
  });

  it('returns null for values that make no valid pass', () => {
    const item = data.items[0]!;
    expect(livePass(anonBlueprint(item), { ...item.sample, memberName: '' })).toBeNull();
  });

  it('throws what is not an invalid pass', () => {
    const item = data.items[0]!;
    const { source: _source, ...bare } = item;
    expect(() => livePass(anonBlueprint(bare as typeof item), item.sample)).toThrow(/no source/);
    const broken = anonBlueprint(item);
    broken.doc.manifest.behaviors = [null];
    expect(() => livePass(broken, item.sample)).toThrow(TypeError);
  });
});
