import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { TemplateManifest } from '../../types.ts';
import type { PackageDoc } from './types.ts';

/** One template version as stored in the fixture: bytes only where the engine reads them. */
export interface HistoryVersion {
  commit: string;
  passJson: unknown;
  manifest: unknown;
  files: Record<string, { sha1: string; text?: string }>;
}

const git = (...args: string[]): Buffer => execFileSync('git', args, { maxBuffer: 1 << 28 });
const needsBytes = (name: string) => name.endsWith('.strings') || name === 'personalization.json';

/** Reads every package's distinct versions from git history, oldest first. */
export function readHistory(): Record<string, HistoryVersion[]> {
  const slugs = git('ls-tree', '--name-only', 'HEAD', 'templates/')
    .toString()
    .split('\n')
    .filter((p) => p && !p.endsWith('_tools'))
    .map((p) => p.replace('templates/', ''));
  const out: Record<string, HistoryVersion[]> = {};
  for (const slug of slugs) {
    const commits = git('log', '--reverse', '--format=%H', '--', `templates/${slug}`)
      .toString()
      .split('\n')
      .filter(Boolean);
    const seen = new Set<string>();
    for (const commit of commits) {
      const names = git('ls-tree', '-r', '--name-only', commit, `templates/${slug}/`)
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((p) => p.slice(`templates/${slug}/`.length));
      if (!names.includes('pass.json') || !names.includes('wallet.template.json')) continue;
      const show = (n: string) => git('show', `${commit}:templates/${slug}/${n}`);
      const files: HistoryVersion['files'] = {};
      for (const n of names) {
        if (n === 'pass.json' || n === 'wallet.template.json') continue;
        const bytes = show(n);
        files[n] = { sha1: createHash('sha1').update(bytes).digest('hex') };
        if (needsBytes(n)) files[n].text = bytes.toString('base64');
      }
      const v = {
        commit: commit.slice(0, 10),
        passJson: JSON.parse(show('pass.json').toString()),
        manifest: JSON.parse(show('wallet.template.json').toString()),
        files,
      };
      const key = JSON.stringify([v.passJson, v.manifest, v.files]);
      if (seen.has(key)) continue;
      seen.add(key);
      (out[slug] ??= []).push(v);
    }
  }
  return out;
}

export function toDoc(v: HistoryVersion): PackageDoc {
  return {
    passJson: v.passJson as PackageDoc['passJson'],
    manifest: v.manifest as TemplateManifest,
    files: Object.fromEntries(
      Object.entries(v.files).map(([n, f]) => [
        n,
        { sha1: f.sha1, bytes: f.text ? new Uint8Array(Buffer.from(f.text, 'base64')) : undefined },
      ]),
    ),
  };
}
