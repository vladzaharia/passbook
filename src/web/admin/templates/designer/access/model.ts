import { hoursText } from '@/passkit/template/access/scope.ts';
import type { AccessManifest, AccessPlan } from '@/passkit/types.ts';
import { type DesignDoc, type Dict, isRecord } from '../model.ts';

export const MAX_PLANS = 12;
export const LABEL_MAX = 24;

export const KIND_LABEL: Record<AccessPlan['kind'], string> = {
  always: '24/7',
  timed: 'Timed',
  guest: 'Guest',
};

/** The access block of the manifest, or null when the template is not an access card. */
export function readAccess(doc: DesignDoc): AccessManifest | null {
  const scan = isRecord(doc.manifest.scan) ? doc.manifest.scan : null;
  const access = scan?.access;
  if (!isRecord(access) || !Array.isArray(access.plans)) return null;
  return access as unknown as AccessManifest;
}

/** One line a person reads under a plan's name. */
export function planSummary(plan: AccessPlan): string {
  const hours = hoursText(plan.hours);
  if (plan.kind === 'always') return 'Any time';
  if (plan.kind === 'timed') return hours || 'No hours yet';
  const visits = plan.visits
    ? `${plan.visits} ${plan.visits === 1 ? 'visit' : 'visits'}`
    : 'Any number of visits';
  const days = plan.days && plan.days > 1 ? `${plan.days} days` : 'One day';
  return [days, visits, hours].filter(Boolean).join(' · ');
}

/** What a pass form needs of a plan: carried in the plan input's schema as `x-plans`. */
export interface PlanOption {
  id: string;
  label: string;
  kind: AccessPlan['kind'];
  summary: string;
  visits?: number;
  days?: number;
}

export const planOption = (plan: AccessPlan): PlanOption => ({
  id: plan.id,
  label: plan.label,
  kind: plan.kind,
  summary: planSummary(plan),
  ...(plan.visits ? { visits: plan.visits } : {}),
  ...(plan.days ? { days: plan.days } : {}),
});

/** A plan id from its label: a-z, 0-9 and _, starting with a letter, once. */
export function planId(label: string, taken: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^[^a-z]+/, '')
      .slice(0, 28) || 'plan';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`;
  return id;
}

/** "Plan 3": a label no plan has. */
export function newLabel(plans: readonly AccessPlan[]): string {
  const labels = plans.map((p) => p.label.toLowerCase());
  let n = plans.length + 1;
  while (labels.includes(`plan ${n}`)) n++;
  return `Plan ${n}`;
}

export const propsOf = (manifest: Dict): Dict =>
  isRecord(manifest.inputs) && isRecord(manifest.inputs.properties)
    ? manifest.inputs.properties
    : {};

/** The inputs of the plan input's neighbours that hold text, for "Suspend when". */
export function textInputs(manifest: Dict): { name: string; label: string; values: string[] }[] {
  return Object.entries(propsOf(manifest)).flatMap(([name, node]) => {
    if (!isRecord(node) || node.type !== 'string' || node['x-widget']) return [];
    const values = Array.isArray(node.enum) ? node.enum.map(String) : [];
    return [{ name, label: typeof node['x-label'] === 'string' ? node['x-label'] : name, values }];
  });
}
