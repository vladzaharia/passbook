import { describe, expect, it } from 'vitest';
import { applyOp } from './apply.ts';
import { sampleDoc } from './fixtures.ts';
import { readActions } from './scan/actions/model.ts';
import { docWithInputs } from './scan/actions/test-fixtures.ts';

describe('renaming an input', () => {
  it('rewrites scan actions, window, notes, bindings and the scan display', () => {
    let doc = docWithInputs();
    const ops = [
      { op: 'scan-enable' },
      { op: 'scan-action-add', kind: 'add' },
      { op: 'scan-window', patch: { from: 'starts' } },
      { op: 'scan-flags', flags: [{ input: 'tier', label: 'VIP' }] },
      {
        op: 'field-source',
        key: 'tier',
        source: { kind: 'input', name: 'balance' },
        optional: false,
      },
    ] as const;
    for (const o of ops) doc = applyOp(doc, o);
    doc = {
      ...doc,
      manifest: {
        ...doc.manifest,
        scan: {
          ...(doc.manifest.scan as object),
          display: {
            v: 1,
            header: { title: 'Welcome' },
            panels: [
              {
                id: 'p_a',
                title: 'Balance',
                rows: [{ id: 'r_b', type: 'field', label: 'Left', value: '{{inputs.balance}}' }],
              },
            ],
          },
        },
      },
    };
    expect(readActions(doc).find((a) => a.id === 'add')?.input).toBe('balance');
    const next = applyOp(doc, { op: 'input-set', name: 'balance', patch: { name: 'credit' } });
    const json = JSON.stringify(next.manifest);
    expect(readActions(next).find((a) => a.id === 'add')?.input).toBe('credit');
    expect(json).toContain('{{inputs.credit}}');
    expect(json).toContain('{{credit}}');
    expect(json).not.toMatch(/\bbalance\b/);
    expect(JSON.stringify(next.passJson)).not.toContain('{{balance}}');
    // Other inputs keep their references.
    expect(next.manifest.scan).toMatchObject({
      window: { from: 'starts' },
      flags: [{ input: 'tier' }],
    });
    expect(sampleDoc().manifest.scan).toBeUndefined();
  });
});
