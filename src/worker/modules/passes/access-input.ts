import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { AccessManifest, Personalization } from '../../../passkit/types.ts';
import { type FieldIssue, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { activeZoneKeys } from './repo-access-zones.ts';

const time = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isNaN(t) ? null : t;
};

/**
 * What an Access card's pass may hold (AX 2.4): a plan of its template, add-on zones that are live
 * zones of the org, an end after its start, and a visit limit only on a guest plan. Pure: the
 * org's zone keys come in. Issues carry the input's name as their path.
 */
export function accessInputIssues(
  access: AccessManifest,
  inputs: Personalization,
  zoneKeys: ReadonlySet<string>,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const names = access.input;
  const plan = access.plans.find((p) => p.id === inputs[names.plan]);
  if (!plan)
    issues.push({
      path: names.plan,
      message: 'Choose one of the card’s plans.',
      code: 'ACCESS_PLAN_UNKNOWN',
    });
  const extra = names.zones === undefined ? undefined : inputs[names.zones];
  const keys = (Array.isArray(extra) ? extra : [extra]).filter(
    (k): k is string => typeof k === 'string' && k !== '',
  );
  if (names.zones !== undefined && keys.some((k) => !zoneKeys.has(k)))
    issues.push({
      path: names.zones,
      message: 'Choose zones that exist and are not archived.',
      code: 'ACCESS_ZONE_UNKNOWN',
    });
  const from = names.from === undefined ? null : time(inputs[names.from]);
  const until = names.until === undefined ? null : time(inputs[names.until]);
  if (from !== null && until !== null && until <= from)
    issues.push({
      path: names.until ?? '',
      message: 'The end must be after the start.',
      code: 'ACCESS_WINDOW',
    });
  const limit = names.visits === undefined ? undefined : inputs[names.visits];
  if (limit !== undefined && limit !== null && limit !== '') {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 999)
      issues.push({
        path: names.visits ?? '',
        message: 'A visit limit is a whole number from 1 to 999.',
        code: 'ACCESS_GUEST_RANGE',
      });
    else if (plan && plan.kind !== 'guest')
      issues.push({
        path: names.visits ?? '',
        message: 'Only a guest plan has a visit limit.',
        code: 'ACCESS_VISITS',
      });
  }
  return issues;
}

/** Refuse an Access card's input that breaks 2.4 (422, with the field's path). Other templates pass. */
export async function assertAccessInput(
  ctx: ServiceContext,
  orgId: string,
  template: ResolvedTemplate,
  input: Personalization,
): Promise<void> {
  const access = template.manifest.scan?.access;
  if (!access) return;
  const keys = access.input.zones === undefined ? [] : await activeZoneKeys(ctx.env.DB, orgId);
  const issues = accessInputIssues(access, applyDefaults(template.manifest, input), new Set(keys));
  const first = issues[0];
  if (first) throw new ValidationError('The pass input is invalid.', issues, first.code);
}
