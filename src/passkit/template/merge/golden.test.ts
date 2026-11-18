import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../types.ts';
import { mergePackages } from './apply.ts';
import { edit, sha } from './merge-test-fixtures.ts';
import { normalize } from './normalize.ts';
import type { PackageDoc } from './types.ts';

/** One template version as stored in the fixture: bytes only where the engine reads them. */
interface HistoryVersion {
  commit: string;
  passJson: unknown;
  manifest: unknown;
  files: Record<string, { sha1: string; text?: string }>;
}

const git = (...args: string[]): Buffer => execFileSync('git', args, { maxBuffer: 1 << 28 });
const needsBytes = (name: string) => name.endsWith('.strings') || name === 'personalization.json';

/** Reads every package's distinct versions from git history, oldest first. */
function readHistory(): Record<string, HistoryVersion[]> {
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
      out[slug] = [...(out[slug] ?? []), v];
    }
  }
  return out;
}

function toDoc(v: HistoryVersion): PackageDoc {
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

// Regenerate with `UPDATE_GOLDENS=1 npx vitest run src/passkit/template/merge/golden.test.ts`.
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'template-history.json',
);
if (process.env.UPDATE_GOLDENS) writeFileSync(FIXTURE, `${JSON.stringify(readHistory())}\n`);
const history: Record<string, HistoryVersion[]> = JSON.parse(readFileSync(FIXTURE, 'utf8'));

/** A scripted fork: a renamed card, a relabelled input and field, and replaced art. */
function fork(doc: PackageDoc): PackageDoc {
  return edit(doc, (d) => {
    d.manifest.description = 'Forked';
    const first = Object.values(d.manifest.inputs?.properties ?? {})[0] as any;
    if (first) first['x-label'] = 'Forked label';
    const style = Object.values(d.passJson).find((v: any) => v?.primaryFields) as any;
    if (style?.primaryFields?.[0]) style.primaryFields[0].label = 'Forked';
    const png = Object.keys(d.files).find((n) => n.endsWith('.png') && !n.startsWith('stamps/'));
    if (png) d.files[png] = { sha1: sha('forked art') };
  });
}

const summary = (b: PackageDoc, o: PackageDoc, t: PackageDoc) => {
  const r = mergePackages(b, o, t);
  const parts: Record<string, number> = {};
  for (const c of r.theirs) parts[c.part] = (parts[c.part] ?? 0) + 1;
  return {
    status: r.status,
    conflicts: r.conflicts.map((c) => `${c.id} ${c.kind}`),
    changes: parts,
    renames: r.renames.map((x) => `${x.kind}:${x.from}>${x.to}`),
  };
};

describe('goldens over templates/ history', () => {
  it('has history for every package', () => {
    expect(Object.keys(history).length).toBeGreaterThanOrEqual(9);
  });
  for (const [slug, versions] of Object.entries(history)) {
    it(`${slug}: every pair of versions`, () => {
      const out: Record<string, unknown> = {};
      for (const [i, vi] of versions.entries())
        for (const vj of versions.slice(i + 1)) {
          const [b, t] = [toDoc(vi), toDoc(vj)];
          // The fork has not edited: upstream fast-forwards, whatever changed.
          const want = normalize(t);
          // `name` is the fork's own, so it stays ours'.
          want.manifest = { ...want.manifest, name: b.manifest.name };
          expect(mergePackages(b, b, t).merged).toEqual(want);
          expect(mergePackages(b, t, b).merged).toEqual(normalize(t));
          out[`${vi.commit}..${vj.commit}`] = summary(b, fork(b), t);
        }
      expect(out).toMatchSnapshot();
    });
  }
});
