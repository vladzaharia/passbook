import { describe, expect, it } from 'vitest';
import { generatedSource } from '../sync.ts';

describe('baked templates', () => {
  it.each(generatedSource.templates.map((t) => [t.slug, t] as const))(
    '%s declares google and samsung designs',
    (_slug, t) => {
      expect(t.manifest.wallets?.schema).toBe(1);
      expect(t.manifest.wallets?.google).toBeDefined();
      expect(t.manifest.wallets?.samsung).toBeDefined();
    },
  );
});
