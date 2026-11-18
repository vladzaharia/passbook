import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mergePackages } from './apply.ts';
import { type HistoryVersion, readHistory, toDoc } from './golden-history.ts';
import { edit, sha } from './merge-fixtures.ts';
import { normalize } from './normalize.ts';
import type { PackageDoc } from './types.ts';

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
