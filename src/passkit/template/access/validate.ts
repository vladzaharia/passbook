import type { TemplateManifest, ValidationIssue } from '../../types.ts';
import { isDateTime, isRecord, propertiesOf, type Rec, typeOf } from '../scan-actions.ts';
import { DAYS, parseSpan } from './hours.ts';

const PLAN_ID = /^[a-z][a-z0-9_]{0,31}$/;
const ZONE_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KINDS = new Set(['always', 'timed', 'guest']);
const TOP_KEYS = new Set(['input', 'plans', 'suspend', 'rules']);
const INPUT_KEYS = ['plan', 'zones', 'from', 'until', 'visits', 'sponsor'];
const PLAN_KEYS = new Set(['id', 'label', 'kind', 'hours', 'zones', 'visits', 'days']);
const WEEK = 7 * 1440;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

type Add = (
  code: string,
  message: string,
  path: string,
  severity?: ValidationIssue['severity'],
) => void;

/** Checks one `WeeklyHours` value; true when it is sound. */
function hoursIssues(hours: unknown, path: string, add: Add): boolean {
  if (!isRecord(hours)) {
    add('ACCESS_SHAPE', 'Hours must be an object of days.', path);
    return false;
  }
  const spans: [number, number][] = [];
  let bad = false;
  for (const [day, list] of Object.entries(hours)) {
    const at = DAYS.indexOf(day as (typeof DAYS)[number]);
    if (at < 0 || !Array.isArray(list)) {
      add('ACCESS_SHAPE', `${day} is not a day with a list of spans.`, `${path}.${day}`);
      bad = true;
      continue;
    }
    if (list.length < 1 || list.length > 4) {
      add('ACCESS_HOURS_SPAN', 'A day takes 1 to 4 spans.', `${path}.${day}`);
      bad = true;
    }
    list.forEach((text, i) => {
      const span = parseSpan(text);
      if (!span) {
        add(
          'ACCESS_HOURS_SPAN',
          'Use HH:MM-HH:MM, with 24:00 only as an end.',
          `${path}.${day}[${i}]`,
        );
        bad = true;
      } else spans.push([at * 1440 + span.start, at * 1440 + span.end]);
    });
  }
  if (bad) return false;
  if (spans.length === 0) {
    add('ACCESS_HOURS_EMPTY', 'These hours never open.', path);
    return false;
  }
  for (const [i, a] of spans.entries())
    for (const b of spans.slice(i + 1))
      for (const shift of [0, WEEK, -WEEK])
        if (a[0] < b[1] + shift && b[0] + shift < a[1]) {
          add('ACCESS_HOURS_OVERLAP', 'Two spans overlap.', path);
          return false;
        }
  return true;
}

function inputIssues(access: Rec, manifest: TemplateManifest, ids: Set<string>, add: Add): void {
  const input = access.input;
  if (!isRecord(input)) {
    add('ACCESS_SHAPE', 'input must be an object.', 'scan.access.input');
    return;
  }
  const props = propertiesOf(manifest);
  for (const key of Object.keys(input))
    if (!INPUT_KEYS.includes(key))
      add('ACCESS_SHAPE', `input.${key} is not an access input.`, `scan.access.input.${key}`);
  const want: Record<string, (s: unknown) => boolean> = {
    plan: (s) => typeOf(s) === 'string',
    zones: (s) =>
      typeOf(s) === 'string' ||
      (typeOf(s) === 'array' && isRecord(s) && typeOf(s.items) === 'string'),
    from: isDateTime,
    until: isDateTime,
    visits: (s) => typeOf(s) === 'integer',
    sponsor: (s) => typeOf(s) === 'string',
  };
  for (const key of INPUT_KEYS) {
    const name = input[key];
    if (name === undefined && key !== 'plan') continue;
    const schema = typeof name === 'string' && Object.hasOwn(props, name) ? props[name] : undefined;
    if (!want[key]?.(schema))
      add('ACCESS_INPUT', `input.${key} must name a matching input.`, `scan.access.input.${key}`);
    else if (key === 'plan' && isRecord(schema) && schema.default !== undefined)
      if (typeof schema.default !== 'string' || !ids.has(schema.default))
        add(
          'ACCESS_PLAN_DEFAULT',
          "The plan input's default is not a plan.",
          'scan.access.input.plan',
        );
  }
}

function planIssues(
  plan: unknown,
  at: number,
  seen: Set<string>,
  labels: Set<string>,
  add: Add,
  zones?: Set<string>,
) {
  const path = `scan.access.plans[${at}]`;
  if (!isRecord(plan)) return add('ACCESS_SHAPE', 'A plan must be an object.', path);
  for (const key of Object.keys(plan))
    if (!PLAN_KEYS.has(key)) add('ACCESS_SHAPE', `${key} is not a plan setting.`, `${path}.${key}`);
  const { id, label, kind } = plan;
  if (typeof id !== 'string' || !PLAN_ID.test(id))
    add('ACCESS_PLAN_ID', 'A plan id is a-z, 0-9 and _, starting with a letter.', `${path}.id`);
  else if (seen.has(id)) add('ACCESS_PLAN_DUPLICATE', 'Each plan id once.', `${path}.id`);
  else seen.add(id);
  const name = typeof label === 'string' ? label.trim().toLowerCase() : '';
  if (typeof label !== 'string' || label.trim() === '' || label.length > 24 || labels.has(name))
    add('ACCESS_PLAN_LABEL', 'A plan label is 1 to 24 characters, each once.', `${path}.label`);
  else labels.add(name);
  if (typeof kind !== 'string' || !KINDS.has(kind))
    return add('ACCESS_SHAPE', 'kind is always, timed or guest.', `${path}.kind`);

  if (kind === 'timed' && plan.hours === undefined)
    add('ACCESS_HOURS_MISSING', 'A timed plan needs hours.', `${path}.hours`);
  if (kind === 'always' && plan.hours !== undefined)
    add('ACCESS_HOURS_NOT_ALLOWED', 'A 24/7 plan has no hours.', `${path}.hours`);
  if (plan.hours !== undefined && kind !== 'always') hoursIssues(plan.hours, `${path}.hours`, add);

  if (kind !== 'guest')
    for (const key of ['visits', 'days'])
      if (plan[key] !== undefined)
        add('ACCESS_GUEST_RANGE', `${key} is for guest plans.`, `${path}.${key}`);
  if (plan.visits !== undefined && !(isInt(plan.visits) && plan.visits >= 1 && plan.visits <= 999))
    add('ACCESS_GUEST_RANGE', 'visits is 1 to 999.', `${path}.visits`);
  if (plan.days !== undefined && !(isInt(plan.days) && plan.days >= 1 && plan.days <= 366))
    add('ACCESS_GUEST_RANGE', 'days is 1 to 366.', `${path}.days`);

  const grants = plan.zones;
  if (!Array.isArray(grants) || grants.length < 1 || grants.length > 24)
    return add('ACCESS_ZONES_EMPTY', 'A plan grants 1 to 24 zones.', `${path}.zones`);
  for (const [i, g] of grants.entries()) {
    const gp = `${path}.zones[${i}]`;
    if (!isRecord(g)) {
      add('ACCESS_SHAPE', 'A grant must be an object.', gp);
      continue;
    }
    for (const key of Object.keys(g))
      if (key !== 'zone' && key !== 'hours')
        add('ACCESS_SHAPE', `${key} is not a grant setting.`, `${gp}.${key}`);
    const zone = g.zone;
    if (typeof zone === 'string') {
      if (zone !== '*' && !ZONE_KEY.test(zone))
        add('ACCESS_ZONE_KEY', 'A zone key is a-z, 0-9 and -, or *.', `${gp}.zone`);
      else if (zones && zone !== '*' && !zones.has(zone))
        add('ACCESS_ZONE_UNKNOWN', `No zone has the key ${zone}.`, `${gp}.zone`, 'warning');
    } else if (!(isRecord(zone) && typeof zone.input === 'string'))
      add('ACCESS_SHAPE', 'zone is a key, * or { input }.', `${gp}.zone`);
    if (g.hours !== undefined) hoursIssues(g.hours, `${gp}.hours`, add);
  }
}

/** Static checks for `scan.access` (AX 2.4). `zones` are the org's zone keys, when known. */
export function accessIssues(
  manifest: TemplateManifest,
  options: { zones?: readonly string[] } = {},
): ValidationIssue[] {
  const scan = (manifest as { scan?: unknown }).scan;
  const access = isRecord(scan) ? scan.access : undefined;
  if (access === undefined) return [];
  const issues: ValidationIssue[] = [];
  const add: Add = (code, message, path, severity = 'error') =>
    issues.push({ severity, code, message, path });
  if (!isRecord(access)) {
    add('ACCESS_SHAPE', 'access must be an object.', 'scan.access');
    return issues;
  }
  for (const key of Object.keys(access))
    if (!TOP_KEYS.has(key))
      add('ACCESS_SHAPE', `access.${key} is not a setting.`, `scan.access.${key}`);
  const actions = (scan as Rec).actions;
  if (!Array.isArray(actions) || !actions.some((a) => isRecord(a) && a.kind === 'check_in'))
    add('ACCESS_NO_CHECK_IN', 'An access card needs a check-in action.', 'scan.actions');

  const plans = access.plans;
  const ids = new Set<string>();
  if (!Array.isArray(plans) || plans.length < 1 || plans.length > 12)
    add('ACCESS_SHAPE', 'plans holds 1 to 12 plans.', 'scan.access.plans');
  else {
    const labels = new Set<string>();
    const zones = options.zones ? new Set(options.zones) : undefined;
    for (const [i, p] of plans.entries()) planIssues(p, i, ids, labels, add, zones);
  }
  inputIssues(access, manifest, ids, add);

  const suspend = access.suspend;
  if (suspend !== undefined) {
    const props = propertiesOf(manifest);
    const ok =
      isRecord(suspend) &&
      typeof suspend.input === 'string' &&
      Object.hasOwn(props, suspend.input) &&
      Array.isArray(suspend.equals) &&
      suspend.equals.length > 0 &&
      suspend.equals.every((v) => typeof v === 'string');
    if (!ok)
      add(
        'ACCESS_INPUT',
        'suspend names an input and the values that hold.',
        'scan.access.suspend',
      );
  }
  const rules = access.rules;
  if (rules !== undefined) {
    const gap = isRecord(rules) ? rules.visitGapMinutes : undefined;
    const wait = isRecord(rules) ? rules.reentryMinutes : undefined;
    if (
      !isRecord(rules) ||
      (gap !== undefined && !(isInt(gap) && gap >= 0 && gap <= 720)) ||
      (wait !== undefined && wait !== null && !(isInt(wait) && wait >= 1 && wait <= 240))
    )
      add(
        'ACCESS_RULES_RANGE',
        'visitGapMinutes is 0-720, reentryMinutes 1-240.',
        'scan.access.rules',
      );
  }
  return issues;
}
