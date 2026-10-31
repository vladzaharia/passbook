import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../../../passkit/types.ts';
import { behaviors } from '../build-check.ts';
import { generatedSource } from '../sync.ts';
import { validateManifest } from './manifest.ts';

describe('baked packages as uploads', () => {
  it('has templates to check', () => {
    expect(generatedSource.templates.length).toBeGreaterThan(0);
  });

  it.each(generatedSource.templates.map((t) => [t.slug, t] as const))(
    '%s passes the uploaded-manifest rules',
    (_slug, t) => {
      const errors = validateManifest(t.manifest, t.passJson as PassJson, {
        uploaded: true,
        behaviors,
      }).filter((i) => i.severity === 'error');
      expect(errors).toEqual([]);
    },
  );
});
