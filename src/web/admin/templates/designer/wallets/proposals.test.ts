import { describe, expect, it } from 'vitest';
import { bakedSlugs } from '@/passkit/template/baked-fixtures.ts';
import { viewOf } from '@/passkit/wallets/view-fixtures.ts';
import { proposeRoles } from './proposals.ts';

describe('role suggestions', () => {
  it('are the same for the same pass, over every baked template', async () => {
    const out: Record<string, string[]> = {};
    for (const slug of bakedSlugs()) {
      const view = await viewOf(slug);
      const once = proposeRoles(view, undefined);
      expect(proposeRoles(view, undefined)).toEqual(once);
      out[slug] = once.map((p) => `${p.role}:${JSON.stringify(p.source)}`);
    }
    expect(out).toMatchSnapshot();
  });

  it('never reuse a field another role reads, nor suggest a role the author set', async () => {
    for (const slug of bakedSlugs()) {
      const view = await viewOf(slug);
      const used = new Set(Object.values(view.roles).flatMap((r) => r?.fields ?? []));
      for (const p of proposeRoles(view, undefined)) {
        if (p.source === false) continue;
        const field = view.fields.find((f) => f.key === (p.source as { field: string }).field);
        expect(used.has(field?.path ?? '')).toBe(false);
      }
      const set = proposeRoles(view, { tier: false, points: false, memberName: false });
      expect(set.some((p) => ['tier', 'points', 'memberName'].includes(p.role))).toBe(false);
    }
  });
});
