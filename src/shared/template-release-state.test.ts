import { describe, expect, it } from 'vitest';
import { TemplateReleaseStateSchema } from './contracts/template-releases.ts';
import { isAlone, type ReleaseFacts, releaseState } from './template-release-state.ts';

const NOW = 1_000_000_000_000;
const ME = 'me';
const OTHER = 'other';

type Role = 'solo' | 'admin' | 'author' | 'reviewer' | 'publisher';
const ROLES: Record<Role, Pick<ReleaseFacts, 'caller' | 'reviewers'>> = {
  solo: {
    caller: { userId: ME, author: true, review: true, publish: true },
    reviewers: { count: 1, includesCaller: true },
  },
  /** An org admin in a team: every capability, but another reviewer exists. */
  admin: {
    caller: { userId: ME, author: true, review: true, publish: true },
    reviewers: { count: 2, includesCaller: true },
  },
  author: {
    caller: { userId: ME, author: true, review: false, publish: false },
    reviewers: { count: 1, includesCaller: false },
  },
  reviewer: {
    caller: { userId: ME, author: false, review: true, publish: false },
    reviewers: { count: 2, includesCaller: true },
  },
  publisher: {
    caller: { userId: ME, author: false, review: false, publish: true },
    reviewers: { count: 2, includesCaller: false },
  },
};

const v = (version: string, at: number, by: string | null = OTHER) => ({
  version,
  at,
  ok: true,
  by,
});
const head = (version: string) => ({ version, at: NOW - 10, byName: 'Alex Kim' });
const V1 = v('v1', 100);
const V2 = v('v2', 200);

type Heads = Pick<ReleaseFacts, 'versions' | 'live' | 'test'>;
const HEADS = {
  empty: { versions: [], live: null, test: null },
  draft: { versions: [V1], live: null, test: null },
  firstReviewed: { versions: [V2], live: null, test: null },
  tried: { versions: [V1], live: null, test: head('v1') },
  released: { versions: [V1], live: head('v1'), test: head('v1') },
  changed: { versions: [V2, V1], live: head('v1'), test: head('v1') },
  ahead: { versions: [V2, V1], live: head('v1'), test: head('v2') },
} satisfies Record<string, Heads>;
type HeadState = keyof typeof HEADS;

type Review = 'none' | 'open' | 'approved' | 'mine';
const REVIEWS: Record<Review, ReleaseFacts['reviews']> = {
  none: [],
  open: [{ version: 'v2', authorId: OTHER, authorName: 'Sam', at: 300, approval: null }],
  approved: [
    {
      version: 'v2',
      authorId: OTHER,
      authorName: 'Sam',
      at: 300,
      approval: { reviewerName: 'Jo', at: 400 },
    },
  ],
  /** The caller asked for this review. */
  mine: [{ version: 'v2', authorId: ME, authorName: 'Me', at: 300, approval: null }],
};

function facts(role: Role, heads: HeadState, review: Review = 'none'): ReleaseFacts {
  return { ...HEADS[heads], reviews: REVIEWS[review], ...ROLES[role] };
}

// One row per head state (and, for a changed template, review state); one column per role.
const TABLE: [HeadState, Review, Record<Role, string | null>][] = [
  [
    'empty',
    'none',
    { solo: 'design', admin: 'design', author: 'design', reviewer: null, publisher: null },
  ],
  [
    'draft',
    'none',
    { solo: 'try', admin: 'try', author: 'request_review', reviewer: null, publisher: null },
  ],
  [
    'firstReviewed',
    'approved',
    { solo: 'release', admin: 'release', author: 'wait', reviewer: 'wait', publisher: 'release' },
  ],
  [
    'tried',
    'none',
    {
      solo: 'release',
      admin: 'request_review',
      author: 'request_review',
      reviewer: null,
      publisher: null,
    },
  ],
  ['released', 'none', { solo: null, admin: null, author: null, reviewer: null, publisher: null }],
  [
    'changed',
    'none',
    {
      solo: 'release',
      admin: 'request_review',
      author: 'request_review',
      reviewer: null,
      publisher: null,
    },
  ],
  [
    'changed',
    'open',
    { solo: 'release', admin: 'review', author: 'wait', reviewer: 'review', publisher: 'wait' },
  ],
  [
    'changed',
    'mine',
    { solo: 'release', admin: 'wait', author: 'wait', reviewer: 'wait', publisher: 'wait' },
  ],
  [
    'changed',
    'approved',
    { solo: 'release', admin: 'release', author: 'wait', reviewer: 'wait', publisher: 'release' },
  ],
  [
    'ahead',
    'none',
    {
      solo: 'release',
      admin: 'request_review',
      author: 'request_review',
      reviewer: null,
      publisher: null,
    },
  ],
  [
    'ahead',
    'open',
    { solo: 'release', admin: 'review', author: 'wait', reviewer: 'review', publisher: 'wait' },
  ],
];

describe('releaseState next step', () => {
  for (const [heads, review, expected] of TABLE)
    for (const role of Object.keys(expected) as Role[])
      it(`${heads} · review ${review} · ${role} → ${expected[role]}`, () => {
        const state = releaseState(facts(role, heads, review));
        expect(state.next).toBe(expected[role]);
        expect(TemplateReleaseStateSchema.parse(state)).toEqual(state);
      });

  it('a version author is never offered their own review', () => {
    const own = { ...facts('reviewer', 'changed', 'open'), versions: [v('v2', 200, ME), V1] };
    expect(releaseState(own).next).toBe('wait');
    const theirs = { ...own, versions: [v('v2', 200, OTHER), V1] };
    expect(releaseState(theirs).next).toBe('review');
  });

  it('offers nothing to a caller without template capabilities', () => {
    const none = { ...facts('author', 'empty'), caller: { ...ROLES.author.caller, author: false } };
    expect(releaseState(none).next).toBeNull();
  });
});

describe('releaseState heads', () => {
  const state = (heads: HeadState, review: Review = 'none') =>
    releaseState(facts('solo', heads, review));

  it('reports the strip for each head state', () => {
    expect(state('empty')).toMatchObject({ live: null, test: null, draft: null });
    expect(state('draft')).toMatchObject({ live: null, test: null, draft: { version: 'v1' } });
    expect(state('tried')).toMatchObject({ test: { version: 'v1', state: 'ahead' } });
    expect(state('released')).toMatchObject({
      live: { version: 'v1', by: 'Alex Kim' },
      test: { version: 'v1', state: 'following' },
      draft: null,
    });
    expect(state('changed')).toMatchObject({ test: { state: 'following' }, draft: { at: 200 } });
    expect(state('ahead')).toMatchObject({ test: { version: 'v2', state: 'ahead' } });
  });

  it('treats a Test head older than Live as following', () => {
    const behind = { ...facts('solo', 'changed'), live: head('v2'), test: head('v1') };
    expect(releaseState(behind)).toMatchObject({ test: { state: 'following' }, draft: null });
  });

  it('skips versions that fail their check', () => {
    const broken = { ...facts('solo', 'changed'), versions: [{ ...V2, ok: false }, V1] };
    expect(releaseState(broken)).toMatchObject({ draft: null, next: null });
    const none = { ...facts('solo', 'draft'), versions: [{ ...V1, ok: false }] };
    expect(releaseState(none)).toMatchObject({ draft: null, next: 'design' });
  });

  it('keeps a restored older Live version behind the newer draft', () => {
    const restored = { ...facts('solo', 'changed'), live: head('v1') };
    expect(releaseState(restored).draft?.version).toBe('v2');
  });

  it('reports review only for the draft version', () => {
    expect(state('changed', 'open').review).toEqual({
      state: 'open',
      version: 'v2',
      by: 'Sam',
      at: 300,
    });
    expect(state('changed', 'approved').review).toEqual({
      state: 'approved',
      version: 'v2',
      by: 'Jo',
      at: 400,
    });
    expect(state('released', 'open').review).toEqual({ state: 'none' });
    const stale = { ...facts('admin', 'changed', 'open'), versions: [v('v3', 300), V2, V1] };
    expect(releaseState(stale)).toMatchObject({
      review: { state: 'none' },
      next: 'request_review',
    });
  });
});

describe('isAlone mirrors the sole approval rule', () => {
  const solo = ROLES.solo;
  it('needs one review-capable member, the caller, with every capability', () => {
    expect(isAlone(solo)).toBe(true);
    expect(isAlone({ ...solo, reviewers: { ...solo.reviewers, count: 2 } })).toBe(false);
    expect(isAlone({ ...solo, reviewers: { ...solo.reviewers, includesCaller: false } })).toBe(
      false,
    );
    for (const cap of ['author', 'review', 'publish'] as const)
      expect(isAlone({ ...solo, caller: { ...solo.caller, [cap]: false } })).toBe(false);
  });
});
