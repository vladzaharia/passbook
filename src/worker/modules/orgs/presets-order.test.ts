import { describe, expect, it } from 'vitest';
import type { EntitlementPresetDto } from '../../../shared/contracts/entitlement-presets.ts';
import { applyKit } from '../channels/apply-test-fixtures.ts';

describe('the presets list', () => {
  it('runs in ladder order, not alphabetical', async () => {
    const t = await applyKit(1);
    const list = (await (
      await t.kit.api('/platform/entitlement-presets', { headers: t.kit.auth.admin() })
    ).json()) as { presets: EntitlementPresetDto[] };
    expect(list.presets.map((p) => p.preset)).toEqual([
      'trial',
      'starter',
      'standard',
      'premium',
      'legacy',
      'developer',
    ]);
  });
});
