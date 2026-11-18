import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../types.ts';
import { mergePackages } from './apply.ts';
import { edit, flat, sha } from './merge-test-fixtures.ts';
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

/** What the scripted fork edits, by identities taken from the version it forked. */
interface ForkPlan {
  input?: string;
  removed?: string;
  field?: string;
  png?: string;
  panel?: string;
}

const mainStyle = (pass: any) =>
  Object.values(pass).find(
    (v: any) =>
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.keys(v).some((k) => k.endsWith('Fields')),
  ) as any;

function planFork(doc: PackageDoc): ForkPlan {
  const inputs = Object.keys((doc.manifest as any).inputs?.properties ?? {});
  return {
    input: inputs[0],
    removed: inputs.length > 1 ? inputs.at(-1) : undefined,
    field: mainStyle(doc.passJson)?.primaryFields?.[0]?.key,
    png: Object.keys(doc.files).find((n) => n.endsWith('.png') && !n.startsWith('stamps/')),
    panel: (doc.manifest as any).scan?.display?.panels?.[0]?.id,
  };
}

/**
 * A scripted fork, applied by identity: a new description, a relabelled input and field, replaced
 * art, a removed input, a new binding and a new scan row.
 */
function fork(doc: PackageDoc, plan: ForkPlan): PackageDoc {
  return edit(doc, (d) => {
    const man = d.manifest;
    man.description = 'Forked';
    const props = man.inputs?.properties ?? {};
    if (plan.input && props[plan.input]) props[plan.input]['x-label'] = 'Forked label';
    if (plan.removed) delete props[plan.removed];
    const field = mainStyle(d.passJson)?.primaryFields?.find((f: any) => f.key === plan.field);
    if (field) {
      field.label = 'Forked';
      man.bindings = [
        ...(man.bindings ?? []),
        { to: { field: field.key, prop: 'changeMessage' }, value: 'Now %@' },
      ];
    }
    if (plan.png && d.files[plan.png]) d.files[plan.png] = { sha1: sha('forked art') };
    const panel = man.scan?.display?.panels?.find((p: any) => p.id === plan.panel);
    if (panel) panel.rows.push({ id: 'forkedRow', type: 'note', text: 'Forked' });
  });
}

const bytes = (d: PackageDoc) => JSON.stringify([d.passJson, d.manifest]);

/** The merge, with what the result keeps that differs from upstream: the fork's surviving edits. */
const summary = (b: PackageDoc, o: PackageDoc, t: PackageDoc) => {
  const r = mergePackages(b, o, t);
  const parts: Record<string, number> = {};
  for (const c of r.theirs) parts[c.part] = (parts[c.part] ?? 0) + 1;
  const [fm, ft] = [flat(r.merged), flat(normalize(t))];
  return {
    status: r.status,
    conflicts: r.conflicts.map((c) => `${c.id} ${c.kind}`),
    changes: parts,
    renames: r.renames.map((x) => `${x.kind}:${x.from}>${x.to}`),
    kept: [...new Set([...Object.keys(fm), ...Object.keys(ft)])]
      .filter((p) => fm[p] !== ft[p] && p !== 'manifest/name')
      .sort()
      .map((p) => `${p} = ${fm[p] ?? '(gone)'}`),
  };
};

let clean = 0;

describe('goldens over templates/ history', () => {
  it('has history for every package', () => {
    expect(Object.keys(history).length).toBeGreaterThanOrEqual(9);
  });
  afterAll(() => {
    // Most pairs merge clean, so the content check above is not vacuous.
    expect(clean).toBeGreaterThan(50);
  });
  for (const [slug, versions] of Object.entries(history)) {
    it(`${slug}: every pair of versions`, () => {
      const out: Record<string, unknown> = {};
      for (const [i, vi] of versions.entries())
        for (const vj of versions.slice(i + 1)) {
          const [b, t] = [toDoc(vi), toDoc(vj)];
          const pair = `${vi.commit}..${vj.commit}`;
          // The fork has not edited: upstream fast-forwards, whatever changed.
          const want = normalize(t);
          // `name` is the fork's own, so it stays ours'.
          want.manifest = { ...want.manifest, name: b.manifest.name };
          // Key order follows ours (§2.6), and upstream history reorders keys: compare structure.
          const ff = mergePackages(b, b, t);
          expect([ff.status, ff.merged], pair).toEqual(['clean', want]);
          expect(bytes(mergePackages(b, t, b).merged), pair).toBe(bytes(normalize(t)));
          // The fork's edits do not overlap upstream's: the result is the fork applied to upstream.
          const plan = planFork(b);
          const m = mergePackages(b, fork(b, plan), t);
          if (m.status === 'clean') {
            const forked = normalize(fork(t, plan));
            forked.manifest = { ...forked.manifest, name: b.manifest.name };
            expect(m.merged, pair).toEqual(forked);
            clean++;
          }
          out[pair] = summary(b, fork(b, plan), t);
        }
      expect(out).toMatchSnapshot();
    });
  }
});
