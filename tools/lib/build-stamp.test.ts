import { describe, expect, it } from 'vitest';
import { buildProblem, parseStamp } from './build-stamp.ts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const clean = { head: HEAD, dirty: false };
const stamp = (sha: string, dirty = false) => JSON.stringify({ sha, dirty });

describe('parseStamp', () => {
  it('reads sha and dirty, nothing else', () => {
    expect(parseStamp(stamp(HEAD))).toEqual({ sha: HEAD, dirty: false });
    for (const bad of ['', 'x', '{}', '{"sha":1,"dirty":false}', '{"sha":"a"}', 'null'])
      expect(parseStamp(bad)).toBeNull();
  });
});

describe('buildProblem, uploading from dist/', () => {
  const run = (over: Partial<Parameters<typeof buildProblem>[0]>) =>
    buildProblem({
      servesUploaded: false,
      git: clean,
      stamp: stamp(HEAD),
      uploadedSha: null,
      ...over,
    });

  it('passes a clean tree with a dist/ built from HEAD', () => {
    expect(run({})).toBeNull();
  });

  it('refuses a dirty tree', () => {
    expect(run({ git: { head: HEAD, dirty: true } })).toContain('clean worktree');
  });

  it('refuses a dist/ built from another commit (the stale build)', () => {
    expect(run({ stamp: stamp(OTHER) })).toContain(`dist/ was built from ${OTHER.slice(0, 9)}`);
  });

  it('refuses a dist/ built from a dirty tree', () => {
    expect(run({ stamp: stamp(HEAD, true) })).toContain('dirty tree');
  });

  it('refuses a missing or unreadable stamp (a build from before the stamp existed)', () => {
    expect(run({ stamp: null })).toContain('no build stamp');
    expect(run({ stamp: 'garbage' })).toContain('no build stamp');
  });
});

describe('buildProblem, promoting an uploaded version', () => {
  const run = (uploadedSha: string | null, git = clean) =>
    buildProblem({ servesUploaded: true, git, stamp: null, uploadedSha });

  it('passes when the upload was built from this checkout', () => {
    expect(run(HEAD)).toBeNull();
  });

  it('refuses when HEAD moved since the upload, or the upload was not recorded', () => {
    expect(run(OTHER)).toContain('this checkout');
    expect(run(null)).toContain('unknown commit');
  });

  it('refuses a dirty tree', () => {
    expect(run(HEAD, { head: HEAD, dirty: true })).toContain('clean worktree');
  });
});
