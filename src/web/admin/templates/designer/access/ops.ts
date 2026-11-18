import type { AccessGrant, AccessManifest, AccessPlan, WeeklyHours } from '@/passkit/types.ts';
import { DEFAULT_SCAN_ACTION } from '@/shared/scan-defaults.ts';
import { type DesignDoc, type Dict, isRecord } from '../model.ts';
import { newLabel, planId, planOption, propsOf, readAccess } from './model.ts';

/** Fields a plan edit may change; `null` removes a setting. */
export interface PlanPatch {
  label?: string;
  hours?: WeeklyHours | null;
  zones?: AccessGrant[];
  visits?: number | null;
  days?: number | null;
}

export type AccessOp =
  | { op: 'access-enable' }
  | { op: 'access-disable' }
  | { op: 'access-plan-add' }
  | { op: 'access-plan-set'; id: string; patch: PlanPatch }
  | { op: 'access-plan-kind'; id: string; kind: AccessPlan['kind'] }
  | { op: 'access-plan-remove'; id: string }
  | { op: 'access-plan-move'; id: string; to: number }
  | { op: 'access-rules'; rules: AccessManifest['rules'] | undefined }
  | { op: 'access-suspend'; suspend: AccessManifest['suspend'] | undefined };

const WORK_WEEK: WeeklyHours = {
  mon: ['09:00-17:00'],
  tue: ['09:00-17:00'],
  wed: ['09:00-17:00'],
  thu: ['09:00-17:00'],
  fri: ['09:00-17:00'],
};

function withoutNulls<T>(base: T, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

/** Writes the access block, and the options the pass form reads from the plan input. */
function write(doc: DesignDoc, access: AccessManifest): DesignDoc {
  const scan = isRecord(doc.manifest.scan) ? doc.manifest.scan : {};
  const props = propsOf(doc.manifest);
  const node = props[access.input.plan];
  const manifest: Dict = { ...doc.manifest, scan: { ...scan, access } };
  if (isRecord(node) && isRecord(doc.manifest.inputs)) {
    const ids = access.plans.map((p) => p.id);
    const current = typeof node.default === 'string' ? node.default : '';
    manifest.inputs = {
      ...doc.manifest.inputs,
      properties: {
        ...props,
        [access.input.plan]: {
          ...node,
          'x-plans': access.plans.map(planOption),
          ...(ids.includes(current) || ids.length === 0 ? {} : { default: ids[0] }),
        },
      },
    };
  }
  return { ...doc, manifest };
}

function unique(taken: ReadonlySet<string>, name: string): string {
  let out = name;
  for (let n = 2; taken.has(out); n++) out = `${name}${n}`;
  return out;
}

function enable(doc: DesignDoc): DesignDoc {
  if (readAccess(doc)) return doc;
  const props = propsOf(doc.manifest);
  const taken = new Set(Object.keys(props));
  const name = (want: string) => {
    const got = unique(taken, want);
    taken.add(got);
    return got;
  };
  const input = {
    plan: name('plan'),
    zones: name('zones'),
    from: name('starts'),
    until: name('ends'),
    visits: name('visits'),
    sponsor: name('sponsor'),
  };
  const status = name('status');
  const plan: AccessPlan = {
    id: 'member',
    label: 'Member',
    kind: 'always',
    zones: [{ zone: '*' }],
  };
  const top = Math.max(
    0,
    ...Object.values(props).map((p) =>
      isRecord(p) && typeof p['x-order'] === 'number' ? p['x-order'] : 0,
    ),
  );
  let order = top;
  const next = () => {
    order += 10;
    return order;
  };
  const nodes: Dict = {
    [input.plan]: {
      type: 'string',
      minLength: 1,
      maxLength: 32,
      default: plan.id,
      'x-label': 'Plan',
      'x-widget': 'access-plan',
      'x-group': 'Access',
      'x-order': next(),
    },
    [input.zones]: {
      type: 'array',
      items: { type: 'string', maxLength: 40 },
      maxItems: 24,
      'x-label': 'Extra zones',
      'x-help': "On top of the plan's zones, in the plan's hours.",
      'x-widget': 'access-zones',
      'x-group': 'Access',
      'x-order': next(),
    },
    [input.from]: {
      type: 'string',
      format: 'date-time',
      'x-label': 'Starts',
      'x-widget': 'datetime',
      'x-noneLabel': 'Now',
      'x-group': 'Access',
      'x-order': next(),
    },
    [input.until]: {
      type: 'string',
      format: 'date-time',
      'x-label': 'Valid until',
      'x-widget': 'datetime',
      'x-noneLabel': 'No end',
      'x-access': 'until',
      'x-group': 'Access',
      'x-order': next(),
    },
    [input.visits]: {
      type: 'integer',
      minimum: 1,
      maximum: 999,
      'x-label': 'Visit limit',
      'x-access': 'visits',
      'x-group': 'Guest',
      'x-order': next(),
    },
    [input.sponsor]: {
      type: 'string',
      maxLength: 80,
      'x-label': 'Guest of',
      'x-access': 'guest',
      'x-scan': 'desk',
      'x-group': 'Guest',
      'x-order': next(),
    },
    [status]: {
      type: 'string',
      enum: ['Active', 'Suspended'],
      default: 'Active',
      'x-label': 'Status',
      'x-group': 'Status',
      'x-order': next(),
    },
  };
  const inputs = isRecord(doc.manifest.inputs) ? doc.manifest.inputs : { type: 'object' };
  const required = Array.isArray(inputs.required) ? (inputs.required as string[]) : [];
  const sample = isRecord(doc.manifest.sample) ? doc.manifest.sample : {};
  const scan = isRecord(doc.manifest.scan) ? doc.manifest.scan : {};
  const access: AccessManifest = {
    input,
    plans: [plan],
    suspend: { input: status, equals: ['Suspended'] },
  };
  return write(
    {
      ...doc,
      manifest: {
        ...doc.manifest,
        inputs: {
          ...inputs,
          type: 'object',
          additionalProperties: false,
          required: [...required, input.plan],
          properties: { ...props, ...nodes },
        },
        sample: { ...sample, [input.plan]: plan.id, [status]: 'Active' },
        scan: {
          ...(scan.actions === undefined ? { actions: [DEFAULT_SCAN_ACTION] } : {}),
          ...scan,
        },
      },
    },
    access,
  );
}

function disable(doc: DesignDoc): DesignDoc {
  const access = readAccess(doc);
  if (!access) return doc;
  const scan = isRecord(doc.manifest.scan) ? { ...doc.manifest.scan } : {};
  delete scan.access;
  const drop = new Set<string>([
    ...Object.values(access.input),
    ...(access.suspend ? [access.suspend.input] : []),
  ]);
  const props = Object.fromEntries(
    Object.entries(propsOf(doc.manifest)).filter(([k]) => !drop.has(k)),
  );
  const inputs = isRecord(doc.manifest.inputs) ? doc.manifest.inputs : {};
  const required = (Array.isArray(inputs.required) ? (inputs.required as string[]) : []).filter(
    (k) => !drop.has(k),
  );
  const { required: _r, ...rest } = inputs;
  const sample = Object.fromEntries(
    Object.entries(isRecord(doc.manifest.sample) ? doc.manifest.sample : {}).filter(
      ([k]) => !drop.has(k),
    ),
  );
  return {
    ...doc,
    manifest: {
      ...doc.manifest,
      scan,
      inputs: { ...rest, ...(required.length ? { required } : {}), properties: props },
      sample,
    },
  };
}

function setKind(plan: AccessPlan, kind: AccessPlan['kind']): AccessPlan {
  if (plan.kind === kind) return plan;
  const { hours, visits: _v, days: _d, ...rest } = plan;
  if (kind === 'always') return { ...rest, kind };
  if (kind === 'timed') return { ...rest, kind, hours: hours ?? WORK_WEEK };
  return { ...rest, kind, ...(hours ? { hours } : {}) };
}

export function applyAccessOp(doc: DesignDoc, o: AccessOp): DesignDoc {
  if (o.op === 'access-enable') return enable(doc);
  if (o.op === 'access-disable') return disable(doc);
  const access = readAccess(doc);
  if (!access) return doc;
  const plans = access.plans;
  const at = (id: string) => plans.findIndex((p) => p.id === id);
  switch (o.op) {
    case 'access-plan-add': {
      if (plans.length >= 12) return doc;
      const label = newLabel(plans);
      const plan: AccessPlan = {
        id: planId(
          label,
          plans.map((p) => p.id),
        ),
        label,
        kind: 'always',
        zones: [{ zone: '*' }],
      };
      return write(doc, { ...access, plans: [...plans, plan] });
    }
    case 'access-plan-set': {
      const i = at(o.id);
      const plan = plans[i];
      if (!plan) return doc;
      return write(doc, {
        ...access,
        plans: plans.map((p, n) => (n === i ? withoutNulls(plan, { ...o.patch }) : p)),
      });
    }
    case 'access-plan-kind': {
      const i = at(o.id);
      const plan = plans[i];
      if (!plan) return doc;
      return write(doc, {
        ...access,
        plans: plans.map((p, n) => (n === i ? setKind(plan, o.kind) : p)),
      });
    }
    case 'access-plan-remove':
      return plans.length <= 1 || at(o.id) < 0
        ? doc
        : write(doc, { ...access, plans: plans.filter((p) => p.id !== o.id) });
    case 'access-plan-move': {
      const from = at(o.id);
      const plan = plans[from];
      if (!plan || o.to < 0 || o.to >= plans.length || o.to === from) return doc;
      const next = plans.filter((p) => p.id !== o.id);
      next.splice(o.to, 0, plan);
      return write(doc, { ...access, plans: next });
    }
    case 'access-rules': {
      const { rules: _r, ...rest } = access;
      return write(
        doc,
        o.rules && Object.keys(o.rules).length > 0 ? { ...rest, rules: o.rules } : rest,
      );
    }
    case 'access-suspend': {
      const { suspend: _s, ...rest } = access;
      return write(doc, o.suspend ? { ...rest, suspend: o.suspend } : rest);
    }
  }
}
