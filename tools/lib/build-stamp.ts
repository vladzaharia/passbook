import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Written next to dist/wallet/wrangler.json, which every wrangler command is redirected to. */
export const STAMP_FILE = 'dist/wallet/build-info.json';

export interface BuildStamp {
  sha: string;
  dirty: boolean;
}

export interface GitState {
  head: string;
  dirty: boolean;
}

/** HEAD and whether anything differs from it, untracked files included (wrangler applies every file in migrations/). */
export function gitState(root: string): GitState {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  return {
    head: git('rev-parse', 'HEAD').trim(),
    dirty: git('status', '--porcelain').trim() !== '',
  };
}

export const stampPath = (root: string) => resolve(root, STAMP_FILE);

export function parseStamp(text: string): BuildStamp | null {
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object' && 'sha' in v && 'dirty' in v)
      if (typeof v.sha === 'string' && typeof v.dirty === 'boolean')
        return { sha: v.sha, dirty: v.dirty };
  } catch {
    // Not JSON: treated as no stamp.
  }
  return null;
}

interface GuardInput {
  /** `--promote` of a version `--migrate-only` uploaded: nothing is uploaded now. */
  servesUploaded: boolean;
  git: GitState;
  /** The contents of STAMP_FILE; null when dist/ has none. */
  stamp: string | null;
  /** The commit recorded when `--migrate-only` uploaded the version; null when none. */
  uploadedSha: string | null;
}

/**
 * Why this run must not ship, or null. The migrations come from the working tree while the Worker
 * comes from dist/, so both must be HEAD, and HEAD must be what was committed.
 */
export function buildProblem({
  servesUploaded,
  git,
  stamp,
  uploadedSha,
}: GuardInput): string | null {
  if (git.dirty)
    return 'The working tree has uncommitted or untracked files. Deploy from the clean worktree that passed npm run check.';
  if (servesUploaded) {
    if (uploadedSha !== git.head)
      return `The uploaded version was built from ${uploadedSha?.slice(0, 9) ?? 'an unknown commit'}, this checkout is ${git.head.slice(0, 9)}. Check out that commit, or run --migrate-only again.`;
    return null;
  }
  const built = stamp === null ? null : parseStamp(stamp);
  if (!built)
    return 'dist/ has no build stamp. Run npm run build (npm run check does) in this checkout.';
  if (built.dirty)
    return 'dist/ was built from a dirty tree. Run npm run build in the clean worktree.';
  if (built.sha !== git.head)
    return `dist/ was built from ${built.sha.slice(0, 9)}, this checkout is ${git.head.slice(0, 9)}. Run npm run build.`;
  return null;
}
