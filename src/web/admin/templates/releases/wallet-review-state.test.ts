import { describe, expect, it } from 'vitest';
import type { TemplateCandidateCurrent } from '@/shared/contracts/template-releases.ts';
import { candidate, release } from './test-fixtures.tsx';
import { newestRelease, walletReview } from './wallet-review.ts';

const loss = {
  capability: 'image.strip',
  path: 'strip',
  support: 'omitted',
  severity: 'omission',
  group: 'holder',
  chosen: false,
  message: 'The strip image is not shown.',
} as const;

const current = (items: TemplateCandidateCurrent['report']['items']): TemplateCandidateCurrent => ({
  version: 'version-2',
  sourceReleaseId: 'release-apple',
  report: {
    schema: 1,
    target: 'google',
    type: 'generic',
    compilerRevision: 1,
    status: items.length ? { kind: 'omissions', count: items.length } : { kind: 'ready' },
    items,
  },
});

const pinned = (approvedOmissions: string[]) =>
  candidate({
    id: 'candidate-g',
    provider: 'google',
    version: 'version-1',
    projection: { schema: 2, provider: 'google', approvedOmissions },
  });
const earlier = release({
  provider: 'google',
  version: 'version-1',
  candidateId: 'candidate-g',
  generation: 1,
});

describe('walletReview against the release a new Apple release left behind', () => {
  it('asks for review of an omission the earlier release did not approve', () => {
    const review = walletReview(current([loss]), null, [pinned([])], earlier);
    expect(review.kind).toBe('review');
  });

  it('stays on Ready with omissions when the earlier release approved every one', () => {
    const review = walletReview(current([loss]), null, [pinned(['image.strip@strip'])], earlier);
    expect(review.kind).toBe('omissions');
  });

  it('is plain Ready when nothing is lost and nothing was approved before', () => {
    expect(walletReview(current([]), null, [pinned([])], earlier).kind).toBe('ready');
  });

  it('is Ready with omissions for a first release with no earlier one', () => {
    expect(walletReview(current([loss]), null, [], null).kind).toBe('omissions');
  });
});

describe('newestRelease', () => {
  it('picks the highest generation', () => {
    const a = release({ id: 'a', generation: 1 });
    const b = release({ id: 'b', generation: 3 });
    const c = release({ id: 'c', generation: 2 });
    expect(newestRelease([a, b, c])?.id).toBe('b');
    expect(newestRelease([])).toBeNull();
  });
});
