import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bakedTemplates } from '../../generated/baked-templates.ts';
import { pipelineRevision } from '../../worker/modules/wallet-providers/projection-pipeline.ts';
import { bakedSlugs, loadBaked } from '../template/baked-fixtures.ts';
import { fidelityReport, reportHash } from './fidelity.ts';
import { googleCompiler } from './google/compilers.ts';
import { samsungCompiler } from './samsung/index.ts';
import { NOW, viewOf } from './view-fixtures.ts';

const FILE = join(import.meta.dirname, 'pipeline-guard.snapshot.json');
const TARGETS = [
  ['google', googleCompiler],
  ['samsung', samsungCompiler],
] as const;

interface Snapshot {
  pipeline: Record<string, string>;
  /** Each baked template's content hash when its reports were taken. */
  templates: Record<string, string>;
  reports: Record<string, Record<string, string>>;
}

const contentOf = (slug: string) => bakedTemplates.find((t) => t.slug === slug)?.version ?? '';

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

/**
 * A release candidate pins `pipelineRevision`, and Q21 trusts it: a pipeline that is the same hash
 * produces the same report. The pin cannot hash the view, behaviors or text rules, so this test
 * does: the report of an unchanged baked template, per target, must not change unless the pipeline pin
 * did. A template whose content changed is skipped until the snapshot is refreshed. Update it with `UPDATE_PIPELINE_GUARD=1 npx vitest run --project unit <this file>`.
 */
describe('pipeline guard', () => {
  it('changes a report only together with a pipeline revision', async () => {
    const current: Snapshot = { pipeline: {}, templates: {}, reports: {} };
    for (const [target] of TARGETS) current.pipeline[target] = await pipelineRevision(target);
    for (const slug of bakedSlugs()) {
      const view = await viewOf(slug, {
        ctx: { assetUrl: (name: string) => `https://img.example/${name}` },
      });
      current.templates[slug] = contentOf(slug);
      current.reports[slug] = {};
      for (const [target, compiler] of TARGETS)
        current.reports[slug][target] = await reportHash(
          fidelityReport({ target, compiler, views: [view], now: NOW }),
        );
    }
    if (process.env.UPDATE_PIPELINE_GUARD === '1') {
      writeFileSync(FILE, `${JSON.stringify(current, null, 2)}\n`);
      return;
    }
    const saved = JSON.parse(readFileSync(FILE, 'utf8')) as Snapshot;
    // Only templates whose content is the same as when the snapshot was taken are comparable.
    const comparable = Object.keys(current.reports).filter(
      (slug) => saved.templates?.[slug] === current.templates[slug],
    );
    for (const [target] of TARGETS) {
      if (saved.pipeline[target] !== current.pipeline[target])
        expect.fail(
          `The ${target} pipeline revision changed. Update pipeline-guard.snapshot.json (UPDATE_PIPELINE_GUARD=1).`,
        );
      const changed = comparable.filter(
        (slug) => saved.reports[slug]?.[target] !== current.reports[slug]?.[target],
      );
      if (changed.length > 0)
        expect.fail(
          `The ${target} report of ${changed.join(', ')} changed but neither the template nor the pipeline revision did. ` +
            'Bump FIDELITY_REVISION (passkit/wallets/fidelity.ts) or the compiler revision, then update the snapshot.',
        );
    }
  }, 120_000);
});
