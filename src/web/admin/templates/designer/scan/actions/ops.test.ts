import { describe, expect, it } from 'vitest';
import { scanIssues } from '@/passkit/template/scan.ts';
import type { ScanAction, ScanActionKind, TemplateManifest } from '@/passkit/types.ts';
import { applyOp, type Op } from '../../apply.ts';
import { sampleDoc } from '../../fixtures.ts';
import type { DesignDoc } from '../../model.ts';
import { actionLocalIssues } from './issues.ts';
import { readActions } from './model.ts';
import { moneyDigits } from './money-digits.ts';
import { docWithInputs } from './test-fixtures.ts';

const errors = (doc: DesignDoc) =>
  scanIssues(doc.manifest as unknown as TemplateManifest).filter((i) => i.severity === 'error');

const KINDS: ScanActionKind[] = ['check_in', 'add', 'take', 'set', 'use_up'];

describe('scan action ops', () => {
  it('starts scanning with one check-in', () => {
    const doc = applyOp(sampleDoc(), { op: 'scan-enable' });
    expect(readActions(doc)).toEqual([{ id: 'check_in', label: 'Check in', kind: 'check_in' }]);
    expect(applyOp(doc, { op: 'scan-enable' })).toBe(doc);
  });

  it.each(KINDS)('adds a %s action that the engine accepts and keeps through JSON', (kind) => {
    let doc = applyOp(docWithInputs(), { op: 'scan-enable' });
    doc = applyOp(doc, { op: 'scan-action-add', kind });
    const added = readActions(doc).at(-1);
    expect(added?.kind).toBe(kind);
    const again = JSON.parse(JSON.stringify(doc.manifest)) as DesignDoc['manifest'];
    expect(again.scan).toEqual(doc.manifest.scan);
    if (kind !== 'use_up') expect(errors(doc)).toEqual([]);
  });

  it('writes every setting of every kind and the engine accepts the result', () => {
    let doc = applyOp(docWithInputs(), { op: 'scan-enable' });
    const run = (op: Op) => {
      doc = applyOp(doc, op);
    };
    run({ op: 'scan-action-set', id: 'check_in', patch: { input: 'starts', allowAgain: false } });
    run({
      op: 'scan-action-set',
      id: 'check_in',
      patch: { repeat: 'cooldown', cooldownMinutes: 15 },
    });
    run({ op: 'scan-action-add', kind: 'add' });
    run({
      op: 'scan-action-set',
      id: 'add',
      patch: {
        amount: { max: 50, default: 5, presets: [5, 10, 20] },
        confirmAbove: 20,
        notify: true,
      },
    });
    run({ op: 'scan-action-add', kind: 'take' });
    run({
      op: 'scan-action-set',
      id: 'take',
      patch: { amount: 5, rewardLabel: 'Free coffee', minRole: 'manager', confirm: false },
    });
    run({ op: 'scan-action-add', kind: 'set' });
    run({ op: 'scan-action-set', id: 'set', patch: { input: 'tier', value: 'option_2' } });
    run({ op: 'scan-action-add', kind: 'use_up' });
    run({
      op: 'scan-action-set',
      id: 'use_up',
      patch: { repeat: 'daily', allowOnConnected: true },
    });
    run({
      op: 'scan-window',
      patch: { from: 'starts', until: 'ends', earlyMinutes: 30, lateMinutes: 15 },
    });
    run({
      op: 'scan-flags',
      flags: [{ input: 'tier', label: 'VIP', equals: ['option_1'], stop: true }],
    });
    const by = Object.fromEntries(readActions(doc).map((a) => [a.id, a]));
    expect(by.add?.amount).toEqual({ max: 50, default: 5, presets: [5, 10, 20] });
    expect(by.take).toMatchObject({
      rewardLabel: 'Free coffee',
      minRole: 'manager',
      confirm: false,
    });
    expect(by.set).toMatchObject({ input: 'tier', value: 'option_2' });
    expect(doc.manifest.scan).toMatchObject({
      window: { from: 'starts', until: 'ends', earlyMinutes: 30, lateMinutes: 15 },
      flags: [{ input: 'tier', stop: true }],
    });
    expect(errors(doc)).toEqual([]);
    expect(JSON.parse(JSON.stringify(doc.manifest.scan))).toEqual(doc.manifest.scan);
  });

  it('null removes a setting and an empty window or flag list disappears', () => {
    let doc = applyOp(docWithInputs(), { op: 'scan-enable' });
    doc = applyOp(doc, { op: 'scan-action-set', id: 'check_in', patch: { confirm: true } });
    doc = applyOp(doc, { op: 'scan-action-set', id: 'check_in', patch: { confirm: null } });
    expect(readActions(doc)[0]).not.toHaveProperty('confirm');
    doc = applyOp(doc, { op: 'scan-window', patch: { earlyMinutes: 10 } });
    doc = applyOp(doc, { op: 'scan-window', patch: { earlyMinutes: null } });
    expect(doc.manifest.scan).not.toHaveProperty('window');
    doc = applyOp(doc, { op: 'scan-flags', flags: [{ input: 'tier', label: 'X' }] });
    doc = applyOp(doc, { op: 'scan-flags', flags: [] });
    expect(doc.manifest.scan).not.toHaveProperty('flags');
  });

  it('a kind change drops settings the new kind does not read', () => {
    let doc = applyOp(docWithInputs(), { op: 'scan-enable' });
    doc = applyOp(doc, { op: 'scan-action-add', kind: 'take' });
    doc = applyOp(doc, {
      op: 'scan-action-set',
      id: 'take',
      patch: { amount: 3, confirmAbove: 2, rewardLabel: 'Free' },
    });
    doc = applyOp(doc, { op: 'scan-action-kind', id: 'take', kind: 'set' });
    const a = readActions(doc).find((x) => x.id === 'take');
    expect(a).toMatchObject({ kind: 'set', input: 'balance' });
    expect(a).not.toHaveProperty('amount');
    expect(a).not.toHaveProperty('rewardLabel');
    doc = applyOp(doc, { op: 'scan-action-kind', id: 'take', kind: 'add' });
    expect(readActions(doc).find((x) => x.id === 'take')?.amount).toBe(1);
  });

  it('moves and removes, keeps one action and caps at six', () => {
    let doc = applyOp(docWithInputs(), { op: 'scan-enable' });
    for (const kind of ['add', 'take', 'set', 'use_up', 'add'] as const)
      doc = applyOp(doc, { op: 'scan-action-add', kind });
    expect(readActions(doc).map((a) => a.id)).toEqual([
      'check_in',
      'add',
      'take',
      'set',
      'use_up',
      'add_2',
    ]);
    expect(applyOp(doc, { op: 'scan-action-add', kind: 'add' })).toBe(doc);
    doc = applyOp(doc, { op: 'scan-action-move', id: 'add_2', to: 0 });
    expect(readActions(doc)[0]?.id).toBe('add_2');
    for (const a of readActions(doc).slice(1))
      doc = applyOp(doc, { op: 'scan-action-remove', id: a.id });
    expect(readActions(doc)).toHaveLength(1);
    expect(applyOp(doc, { op: 'scan-action-remove', id: 'add_2' })).toBe(doc);
  });

  it('reports engine issues for the open draft', () => {
    let doc = applyOp(docWithInputs(), { op: 'scan-enable' });
    doc = applyOp(doc, { op: 'scan-action-add', kind: 'take' });
    doc = applyOp(doc, { op: 'scan-action-set', id: 'take', patch: { input: 'tier' } });
    const found = actionLocalIssues(doc);
    expect(found.map((i) => i.code)).toContain('SCAN_INPUT_NOT_NUMBER');
    expect(found[0]?.path).toBe('scan.actions.1.input');
  });

  it('a new action binds the stamp input when the card has one', () => {
    const doc = applyOp(docWithInputs(), { op: 'scan-enable' });
    doc.manifest.stamps = { input: 'balance', goal: 8, art: { filled: 'a', empty: 'b' } };
    const next = applyOp(doc, { op: 'scan-action-add', kind: 'add' });
    expect(readActions(next).at(-1)).toMatchObject({
      id: 'stamp',
      label: 'Stamp',
      input: 'balance',
      amount: 1,
    });
  });
});

describe('scan action money', () => {
  const money = (currency: string) => {
    let doc = applyOp(docWithInputs(), { op: 'scan-enable' });
    doc = applyOp(doc, { op: 'scan-action-add', kind: 'take' });
    doc = applyOp(doc, { op: 'scan-action-set', id: 'take', patch: { input: 'balance' } });
    const props = (doc.manifest.inputs as { properties: Record<string, Record<string, unknown>> })
      .properties;
    props.balance = { ...props.balance, 'x-format': 'currency', 'x-currency': currency };
    return doc;
  };

  it('keeps a decimal amount exact through the manifest JSON', () => {
    let doc = money('USD');
    doc = applyOp(doc, {
      op: 'scan-action-set',
      id: 'take',
      patch: { amount: { max: 99.99, presets: [0.1, 2.5], default: 4.5 } },
    });
    const again = JSON.parse(JSON.stringify(doc.manifest)) as DesignDoc['manifest'];
    expect(readActions({ ...doc, manifest: again }).at(-1)?.amount).toEqual({
      max: 99.99,
      presets: [0.1, 2.5],
      default: 4.5,
    });
    expect(errors(doc)).toEqual([]);
  });

  it('moneyDigits follows the currency, and the engine refuses decimals in JPY', () => {
    const jpy = money('JPY');
    const take = readActions(jpy).at(-1) as ScanAction;
    expect(moneyDigits(jpy, take)).toBe(0);
    expect(moneyDigits(money('USD'), take)).toBe(2);
    expect(moneyDigits(money('BHD'), take)).toBe(3);
    const bad = applyOp(jpy, { op: 'scan-action-set', id: 'take', patch: { amount: 1.5 } });
    expect(errors(bad).length).toBeGreaterThan(0);
  });
});
