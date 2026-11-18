import { describe, expect, it } from 'vitest';
import { accessIssues } from '@/passkit/template/access/validate.ts';
import type { TemplateManifest } from '@/passkit/types.ts';
import { applyOp } from '../apply.ts';
import { sampleDoc } from '../fixtures.ts';
import type { DesignDoc } from '../model.ts';
import { accessLocalIssues, serverDuplicate } from './issues.ts';
import { planId, readAccess } from './model.ts';

const issuesOf = (doc: DesignDoc) => accessIssues(doc.manifest as unknown as TemplateManifest);
const enabled = (): DesignDoc => applyOp(sampleDoc(), { op: 'access-enable' });

describe('access ops', () => {
  it('enables a valid access card: block, inputs, check-in', () => {
    const doc = enabled();
    const access = readAccess(doc);
    expect(access?.plans).toHaveLength(1);
    expect(access?.input).toMatchObject({ plan: 'plan', zones: 'zones' });
    expect(issuesOf(doc)).toEqual([]);
    const scan = doc.manifest.scan as { actions: { kind: string }[] };
    expect(scan.actions.some((a) => a.kind === 'check_in')).toBe(true);
    const props = (doc.manifest.inputs as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(props.plan?.['x-widget']).toBe('access-plan');
    expect(props.zones?.['x-widget']).toBe('access-zones');
    expect(props.plan?.['x-plans']).toEqual([
      { id: 'member', label: 'Member', kind: 'always', summary: 'Any time' },
    ]);
  });

  it('keeps names that exist and does nothing twice', () => {
    const base = sampleDoc();
    const props = {
      plan: { type: 'string' },
      ...(base.manifest.inputs as { properties: object }).properties,
    };
    base.manifest.inputs = { type: 'object', properties: props };
    const doc = applyOp(base, { op: 'access-enable' });
    expect(readAccess(doc)?.input.plan).toBe('plan2');
    expect(applyOp(doc, { op: 'access-enable' })).toBe(doc);
  });

  it('adds, renames, retypes and removes plans, and the form options follow', () => {
    let doc = enabled();
    doc = applyOp(doc, { op: 'access-plan-add' });
    expect(readAccess(doc)?.plans.map((p) => p.id)).toEqual(['member', 'plan_2']);
    doc = applyOp(doc, { op: 'access-plan-set', id: 'plan_2', patch: { label: 'Off-peak' } });
    doc = applyOp(doc, { op: 'access-plan-kind', id: 'plan_2', kind: 'timed' });
    expect(issuesOf(doc)).toEqual([]);
    const props = (doc.manifest.inputs as { properties: Record<string, Record<string, unknown>> })
      .properties;
    const options = props.plan?.['x-plans'] as { id: string; summary: string }[];
    expect(options[1]).toMatchObject({ id: 'plan_2', summary: 'Mon–Fri 9 AM–5 PM' });
    doc = applyOp(doc, { op: 'access-plan-move', id: 'plan_2', to: 0 });
    expect(readAccess(doc)?.plans.map((p) => p.id)).toEqual(['plan_2', 'member']);
    doc = applyOp(doc, { op: 'access-plan-remove', id: 'plan_2' });
    expect(readAccess(doc)?.plans.map((p) => p.id)).toEqual(['member']);
    expect(applyOp(doc, { op: 'access-plan-remove', id: 'member' })).toBe(doc);
  });

  it('moves the default when the plan it names is removed', () => {
    let doc = enabled();
    doc = applyOp(doc, { op: 'access-plan-add' });
    doc = applyOp(doc, { op: 'access-plan-remove', id: 'member' });
    const props = (doc.manifest.inputs as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(props.plan?.default).toBe('plan_2');
    expect(issuesOf(doc)).toEqual([]);
  });

  it('drops hours and guest terms when the type changes', () => {
    let doc = enabled();
    doc = applyOp(doc, { op: 'access-plan-kind', id: 'member', kind: 'guest' });
    doc = applyOp(doc, { op: 'access-plan-set', id: 'member', patch: { visits: 5, days: 2 } });
    expect(readAccess(doc)?.plans[0]).toMatchObject({ kind: 'guest', visits: 5, days: 2 });
    doc = applyOp(doc, { op: 'access-plan-kind', id: 'member', kind: 'always' });
    expect(readAccess(doc)?.plans[0]).toEqual({
      id: 'member',
      label: 'Member',
      kind: 'always',
      zones: [{ zone: '*' }],
    });
  });

  it('disables access and takes its inputs with it', () => {
    const doc = applyOp(enabled(), { op: 'access-disable' });
    expect(readAccess(doc)).toBeNull();
    const names = Object.keys(
      (doc.manifest.inputs as { properties: Record<string, unknown> }).properties,
    );
    expect(names).not.toContain('plan');
    expect(names).not.toContain('zones');
  });

  it('makes ids from labels, once each', () => {
    expect(planId('24/7 Gold', [])).toBe('gold');
    expect(planId('Off-peak', ['off_peak'])).toBe('off_peak_2');
    expect(planId('###', [])).toBe('plan');
  });
});

describe('access issues in the designer', () => {
  it('words problems in the plan name and says which day overlaps', () => {
    let doc = enabled();
    doc = applyOp(doc, { op: 'access-plan-kind', id: 'member', kind: 'timed' });
    doc = applyOp(doc, {
      op: 'access-plan-set',
      id: 'member',
      patch: { label: 'Off-peak', hours: { mon: ['06:00-10:00', '09:00-12:00'] }, zones: [] },
    });
    const messages = accessLocalIssues(doc).map((i) => i.message);
    expect(messages).toContain('Off-peak: hours overlap on Monday.');
    expect(messages).toContain('Off-peak has no zones.');
  });

  it('hides the server copy of a problem the draft already names', () => {
    const local = [
      {
        severity: 'error' as const,
        code: 'ACCESS_ZONES_EMPTY',
        path: 'scan.access.plans[0].zones',
        message: 'x',
      },
    ];
    const server = { ...local[0]!, message: 'A plan grants 1 to 24 zones.' };
    expect(serverDuplicate(server, local)).toBe(true);
    expect(serverDuplicate({ ...server, path: 'scan.access.plans[1].zones' }, local)).toBe(false);
    expect(serverDuplicate({ ...server, code: 'ACCESS_SHAPE' }, local)).toBe(false);
  });
});
