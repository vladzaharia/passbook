import type { FieldDef, FormValues } from '../schema-form/schema.ts';
import type { PlanChoice } from '../schema-form/schema-access.ts';

/** What the plan a pass holds changes in the rest of the form. */
export interface AccessView {
  /** The plan input's key, when the form has one. */
  planKey: string | undefined;
  plan: PlanChoice | undefined;
  /** Fields that only a guest plan uses; not shown otherwise. */
  hidden: ReadonlySet<string>;
  /** Per field: what changes with the plan (placeholder, the "none" label). */
  override: (field: FieldDef) => FieldDef;
}

/** Reads the form's Access inputs against the values. Plain data in, plain data out. */
export function accessView(fields: readonly FieldDef[], values: FormValues): AccessView {
  const planField = fields.find((f) => f.widget === 'access-plan');
  const chosen = planField ? values[planField.key] : undefined;
  const plan = planField?.plans?.find((p) => p.id === chosen);
  const guest = plan?.kind === 'guest';
  const hidden = new Set(
    planField && !guest
      ? fields.filter((f) => f.access === 'visits' || f.access === 'guest').map((f) => f.key)
      : [],
  );
  const override = (field: FieldDef): FieldDef => {
    if (!planField) return field;
    if (field.access === 'visits')
      return { ...field, placeholder: plan?.visits ? String(plan.visits) : 'No limit' };
    if (field.access === 'until')
      return { ...field, noneLabel: guest ? 'Ends at midnight' : 'No end' };
    return field;
  };
  return { planKey: planField?.key, plan, hidden, override };
}

/** Values after the plan changes: a plan that is not a guest plan leaves no guest settings behind. */
export function afterPlanChange(
  fields: readonly FieldDef[],
  values: FormValues,
  planId: string | undefined,
): FormValues {
  const planField = fields.find((f) => f.widget === 'access-plan');
  if (!planField) return values;
  const next = { ...values };
  if (planId === undefined) delete next[planField.key];
  else next[planField.key] = planId;
  if (planField.plans?.find((p) => p.id === planId)?.kind === 'guest') return next;
  for (const f of fields) if (f.access === 'visits' || f.access === 'guest') delete next[f.key];
  return next;
}
