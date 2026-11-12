import { describe, expect, it } from 'vitest';
import { CreateTemplateCandidateSchema } from './template-releases.ts';

const scope = { orgId: 'org', mode: 'live', version: 'v1' } as const;

describe('template candidate provider scope', () => {
  it('keeps Apple candidates distinct from provider projections', () => {
    expect(CreateTemplateCandidateSchema.safeParse({ ...scope, provider: 'apple' }).success).toBe(
      true,
    );
    expect(
      CreateTemplateCandidateSchema.safeParse({
        ...scope,
        provider: 'apple',
        sourceReleaseId: 'apple-release',
        projection: {},
      }).success,
    ).toBe(false);
  });

  it.each(['google', 'samsung'] as const)(
    'requires a selected Apple source and projection for %s',
    (provider) => {
      expect(CreateTemplateCandidateSchema.safeParse({ ...scope, provider }).success).toBe(false);
      expect(
        CreateTemplateCandidateSchema.safeParse({
          ...scope,
          provider,
          sourceReleaseId: 'apple-release',
        }).success,
      ).toBe(false);
      expect(
        CreateTemplateCandidateSchema.safeParse({
          ...scope,
          provider,
          sourceReleaseId: 'apple-release',
          projection: {},
        }).success,
      ).toBe(true);
    },
  );
});
