import { describe, expect, it } from 'vitest';
import { guideExamples } from '../../developers/model/load.ts';
import { buildSearchIndex } from '../../developers/search/build.ts';
import { fillFor, type Launch } from './launch.ts';
import type { RunOp } from './types.ts';

const DIR = 'docs/developers/snippets/guides';

describe('one id scheme for ?sample=', () => {
  const examples = guideExamples(DIR);
  const single = examples.filter((e) => e.curl && e.ops.length === 1);

  it('is the snippet file stem, in the search index and on the Example the Console reads', () => {
    expect(single.length).toBeGreaterThan(0);
    for (const e of examples) expect(e.id, e.guide).toMatch(/^[a-z0-9-]+$/);
    const index = buildSearchIndex({ pages: [], errors: [], webhookEvents: [] } as never, single);
    expect(index.samples.map((s) => s.id)).toEqual(single.map((e) => e.id));
  });

  it('opens the Console on the sample the index names', () => {
    for (const e of single) {
      const body = /-d '([\s\S]*)'\s*$/.exec(e.curl?.replaceAll('\\\n', ' ') ?? '')?.[1];
      const op = {
        id: e.ops[0],
        samples: { [e.id]: { query: {}, ...(body ? { body: JSON.parse(body) } : {}) } },
      } as unknown as RunOp;
      const launch: Launch = { op: e.ops[0] ?? null, sample: e.id, from: null, prefill: null };
      expect(fillFor(op, launch).source, e.id).toBe('guide');
    }
  });
});
