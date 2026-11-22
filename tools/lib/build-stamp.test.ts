import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProblem, type GitState, gitState, parseStamp } from './build-stamp.ts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const clean: GitState = { head: HEAD, changed: [] };
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
    expect(run({ git: { head: HEAD, changed: ['HANDOFF.md'] } })).toContain('clean worktree');
  });

  it('refuses a dist/ built from another commit (the stale build)', () => {
    expect(run({ stamp: stamp(OTHER) })).toContain(`dist/ was built from ${OTHER.slice(0, 9)}`);
  });

  it('refuses an e2e dist/, even with a matching sha and a clean tree', () => {
    const e2e = JSON.stringify({ sha: HEAD, dirty: false, e2e: true });
    expect(parseStamp(e2e)).toEqual({ sha: HEAD, dirty: false, e2e: true });
    expect(run({ stamp: e2e })).toContain('e2e build');
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
    expect(run(HEAD, { head: HEAD, changed: ['HANDOFF.md'] })).toContain('clean worktree');
  });
});

describe('buildProblem, dirty tree message', () => {
  const dirty = (changed: string[]) =>
    buildProblem({
      servesUploaded: false,
      git: { head: HEAD, changed },
      stamp: stamp(HEAD),
      uploadedSha: null,
    });

  it('names the paths', () => {
    expect(dirty(['HANDOFF.md', 'docs/audits/a.md'])).toContain(
      '2 uncommitted or untracked paths: HANDOFF.md, docs/audits/a.md.',
    );
  });

  it('lists ten and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => `f${i}`);
    const message = dirty(many) ?? '';
    expect(message).toContain('f9, and 3 more');
    expect(message).not.toContain('f10');
  });
});

describe('gitState', () => {
  it('sees an untracked file a global excludes file would hide, and every file in an untracked directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-stamp-'));
    const globalConfig = join(dir, 'gitconfig');
    const repo = join(dir, 'repo');
    writeFileSync(join(dir, 'ignore'), '*.log\nvendor/\n');
    writeFileSync(globalConfig, `[core]\n\texcludesFile = ${join(dir, 'ignore')}\n`);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' });
    execFileSync('git', ['init', '-q', repo], { env });
    writeFileSync(join(repo, 'a.txt'), 'a');
    git('add', 'a.txt');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
    writeFileSync(join(repo, 'x.log'), 'x');
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const state = gitState(repo);
      expect(state.head).toMatch(/^[0-9a-f]{40}$/);
      expect(state.changed).toEqual(['x.log']);
    } finally {
      process.env = saved;
    }
  });
});
