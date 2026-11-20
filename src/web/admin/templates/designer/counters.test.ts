import { describe, expect, it } from 'vitest';
import { validateManifest } from '@/passkit/template/manifest.ts';
import type { TemplateManifest } from '@/passkit/types.ts';
import { applyOp, type Op } from './apply.ts';
import { hasScan, readCounters, slugOf } from './counters.ts';
import { sampleDoc } from './fixtures.ts';
import type { DesignDoc } from './model.ts';

const run = (doc: DesignDoc, ...ops: Op[]) => ops.reduce(applyOp, doc);
const errors = (doc: DesignDoc) =>
  validateManifest(doc.manifest as unknown as TemplateManifest, {})
    .filter((i) => i.severity === 'error' && i.code.startsWith('COUNTER'))
    .map((i) => i.code);

describe('counters', () => {
  it('adds one with its input, label field and binding, and the engine accepts it', () => {
    const doc = run(sampleDoc(), { op: 'counter-add', label: 'Visits' });
    const [c] = readCounters(doc);
    expect(c).toMatchObject({ id: 'visits', input: 'visits', size: 10, label: 'Visits' });
    const props = (doc.manifest.inputs as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(props.visits).toMatchObject({ type: 'integer', minimum: 0, default: 10 });
    expect(doc.manifest.bindings).toContainEqual({
      to: { field: 'visits' },
      value: '{{pass.counters.visits.text}}',
    });
    expect(errors(doc)).toEqual([]);
  });

  it('numbers an id that is taken and stops at four', () => {
    expect(slugOf('Visits', ['visits'])).toBe('visits_2');
    expect(slugOf('3 uses', [])).toBe('c_3_uses');
    let doc = sampleDoc();
    for (const n of ['a', 'b', 'c', 'd', 'e']) doc = run(doc, { op: 'counter-add', label: n });
    expect(readCounters(doc)).toHaveLength(4);
  });

  it('sets the goal, the label and the input default together', () => {
    const doc = run(
      sampleDoc(),
      { op: 'counter-add', label: 'Visits' },
      { op: 'counter-set', id: 'visits', patch: { size: 12, label: 'Left' } },
    );
    expect(readCounters(doc)[0]).toMatchObject({ size: 12, label: 'Left' });
    const props = (doc.manifest.inputs as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(props.visits?.default).toBe(12);
    expect(errors(doc)).toEqual([]);
  });

  it('adds Use one and Refill, and Refill follows the goal', () => {
    let doc = run(
      sampleDoc(),
      { op: 'counter-add', label: 'Visits' },
      { op: 'counter-scan', id: 'visits', kind: 'use', on: true },
      { op: 'counter-scan', id: 'visits', kind: 'refill', on: true },
    );
    const [c] = readCounters(doc);
    expect(c && hasScan(doc, c, 'use')).toBe(true);
    expect(c && hasScan(doc, c, 'refill')).toBe(true);
    doc = run(doc, { op: 'counter-set', id: 'visits', patch: { size: 6 } });
    const actions = (doc.manifest.scan as { actions: Record<string, unknown>[] }).actions;
    expect(actions.find((a) => a.kind === 'set')).toMatchObject({ value: 6, minRole: 'manager' });
    doc = run(doc, { op: 'counter-scan', id: 'visits', kind: 'use', on: false });
    expect((doc.manifest.scan as { actions: unknown[] }).actions).toHaveLength(1);
  });

  it('removes the counter, its field, bindings, scanner actions and the input it made', () => {
    const doc = run(
      sampleDoc(),
      { op: 'counter-add', label: 'Visits' },
      { op: 'counter-scan', id: 'visits', kind: 'use', on: true },
      { op: 'counter-scan', id: 'visits', kind: 'refill', on: true },
      { op: 'counter-remove', id: 'visits' },
    );
    expect(doc.manifest.counters).toBeUndefined();
    expect(doc.manifest.scan).toBeUndefined();
    expect(doc.manifest.sample).not.toHaveProperty('visits');
    expect(JSON.stringify(doc.manifest.inputs)).not.toContain('visits');
    expect(JSON.stringify(doc.manifest.bindings)).not.toContain('pass.counters');
    expect(JSON.stringify(doc.passJson)).not.toContain('"visits"');
  });
});
