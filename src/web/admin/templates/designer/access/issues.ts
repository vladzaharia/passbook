import { accessIssues } from '@/passkit/template/access/validate.ts';
import type { AccessPlan, TemplateManifest, ValidationIssue } from '@/passkit/types.ts';
import { DAY_NAME, DAYS, weekProblems } from '../../../../ui/week-grid/hours.ts';
import type { DesignDoc } from '../model.ts';
import { readAccess } from './model.ts';
import { planIndexOf } from './plan-path.ts';

const GRANT_HOURS = /\.zones\[(\d+)\]\.hours/;

/** The issue's copy, in the plan's own words. */
function friendly(code: string, label: string, fallback: string): string {
  switch (code) {
    case 'ACCESS_ZONES_EMPTY':
      return `${label} has no zones.`;
    case 'ACCESS_HOURS_MISSING':
      return `${label} needs hours.`;
    case 'ACCESS_HOURS_NOT_ALLOWED':
      return `${label} is 24/7 and takes no hours.`;
    case 'ACCESS_HOURS_EMPTY':
      return `${label} never opens.`;
    case 'ACCESS_PLAN_LABEL':
      return `${label}: use 1 to 24 characters, each name once.`;
    default:
      return `${label}: ${fallback}`;
  }
}

function overlapIssues(plan: AccessPlan, path: string, label: string): ValidationIssue[] {
  const grant = GRANT_HOURS.exec(path);
  const hours = grant ? plan.zones[Number(grant[1])]?.hours : plan.hours;
  const days = weekProblems(hours);
  return DAYS.filter((d) => days[d]).map((d) => ({
    severity: 'error' as const,
    code: 'ACCESS_HOURS_OVERLAP',
    path: `${path}.${d}`,
    message: `${label}: hours overlap on ${DAY_NAME[d]}.`,
  }));
}

/** `accessIssues` for the open draft, worded for the designer; the server's dry run says the same. */
export function accessLocalIssues(doc: DesignDoc): ValidationIssue[] {
  const access = readAccess(doc);
  if (!access) return [];
  const found = accessIssues(doc.manifest as unknown as TemplateManifest);
  return found.flatMap((issue) => {
    const at = planIndexOf(issue.path);
    const plan = at === null ? undefined : access.plans[at];
    if (!plan) return [issue];
    const label = plan.label || `Plan ${(at ?? 0) + 1}`;
    if (issue.code === 'ACCESS_HOURS_OVERLAP') return overlapIssues(plan, issue.path ?? '', label);
    return [{ ...issue, message: friendly(issue.code, label, issue.message) }];
  });
}

/** The server's copy of a problem the draft already names: same code, same plan. */
export const serverDuplicate = (
  server: ValidationIssue,
  local: readonly ValidationIssue[],
): boolean =>
  server.code.startsWith('ACCESS_') &&
  local.some(
    (l) =>
      l.code === server.code &&
      planIndexOf(l.path) === planIndexOf(server.path) &&
      (planIndexOf(l.path) !== null || l.path === server.path),
  );

/** Problems about one plan, by the day when the path says it. */
export function forPlan(issues: readonly ValidationIssue[], index: number): ValidationIssue[] {
  return issues.filter((i) => planIndexOf(i.path) === index);
}

/** Message per day for the plan's own hours (`zone` null) or one grant's. */
export function dayErrors(
  issues: readonly ValidationIssue[],
  zone: number | null,
): Partial<Record<(typeof DAYS)[number], string>> {
  const out: Partial<Record<(typeof DAYS)[number], string>> = {};
  for (const i of issues) {
    if (i.code !== 'ACCESS_HOURS_OVERLAP') continue;
    const path = i.path ?? '';
    const grant = GRANT_HOURS.exec(path);
    if (zone === null ? grant !== null : grant === null || Number(grant[1]) !== zone) continue;
    const day = DAYS.find((d) => path.endsWith(`.hours.${d}`));
    if (day) out[day] = i.message;
  }
  return out;
}
