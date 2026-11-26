import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Written next to dist/passbook/wrangler.json, which every wrangler command is redirected to. */
export const STAMP_FILE = 'dist/passbook/build-info.json';

export interface BuildStamp {
  sha: string;
  dirty: boolean;
  /** Written by tools/e2e-server.ts: this dist/ carries raised rate limits and must never ship. */
  e2e?: true;
}

export interface GitState {
  head: string;
  /** Paths that differ from HEAD, untracked included; empty when clean. */
  changed: string[];
}

/**
 * HEAD and every path that differs from it, untracked files included (wrangler applies every file in
 * migrations/). The repo's own .gitignore applies; a global excludes file does not, or it would hide files.
 */
export function gitState(root: string): GitState {
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'core.excludesFile=/dev/null', ...a], {
      cwd: root,
      encoding: 'utf8',
    });
  return {
    head: git('rev-parse', 'HEAD').trim(),
    changed: git('status', '--porcelain', '--untracked-files=all')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.slice(3)),
  };
}

const LISTED = 10;
const dirtyMessage = (changed: string[]) =>
  `The working tree has ${changed.length} uncommitted or untracked path${changed.length === 1 ? '' : 's'}: ${changed.slice(0, LISTED).join(', ')}${changed.length > LISTED ? `, and ${changed.length - LISTED} more` : ''}. Deploy from the clean worktree that passed npm run check.`;

export const stampPath = (root: string) => resolve(root, STAMP_FILE);

export function parseStamp(text: string): BuildStamp | null {
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object' && 'sha' in v && 'dirty' in v)
      if (typeof v.sha === 'string' && typeof v.dirty === 'boolean')
        return {
          sha: v.sha,
          dirty: v.dirty,
          ...('e2e' in v && v.e2e === true ? { e2e: true as const } : {}),
        };
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
  /** `e2eReleaseProblems` of dist/passbook (tools/lib/e2e-release.ts); empty for a deployable Worker. */
  e2eRelease?: string[];
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
  e2eRelease = [],
}: GuardInput): string | null {
  if (git.changed.length > 0) return dirtyMessage(git.changed);
  if (servesUploaded) {
    if (uploadedSha !== git.head)
      return `The uploaded version was built from ${uploadedSha?.slice(0, 9) ?? 'an unknown commit'}, this checkout is ${git.head.slice(0, 9)}. Check out that commit, or run --migrate-only again.`;
    return null;
  }
  const built = stamp === null ? null : parseStamp(stamp);
  if (!built)
    return 'dist/ has no build stamp. Run npm run build (npm run check does) in this checkout.';
  if (built.e2e) return 'dist/ is an e2e build (raised rate limits). Run npm run build.';
  if (e2eRelease.length > 0)
    return `dist/ carries the e2e provider release: ${e2eRelease[0]}. Run npm run build.`;
  if (built.dirty)
    return 'dist/ was built from a dirty tree. Run npm run build in the clean worktree.';
  if (built.sha !== git.head)
    return `dist/ was built from ${built.sha.slice(0, 9)}, this checkout is ${git.head.slice(0, 9)}. Run npm run build.`;
  return null;
}
