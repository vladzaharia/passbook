import { Link } from '@tanstack/react-router';
import { formatCount } from '@/web/lib/format.ts';
import { Callout } from '@/web/ui/index.ts';
import { pressedLimits, viewOfOrgPlan } from '../plan/limits.ts';
import { useOrgPlan } from '../plan/queries.ts';

/**
 * One line on Overview when a plan limit is at 80% or more, or reached; nothing otherwise. The plan
 * itself lives on its own page.
 */
export function PlanNotice({ orgId }: { orgId: string }) {
  const plan = useOrgPlan(orgId);
  const pressed = plan.data ? pressedLimits(viewOfOrgPlan(plan.data)) : [];
  const worst = pressed[0];
  if (!worst || worst.limit === null) return null;
  const more = pressed.length - 1;
  return (
    <Callout
      tone="warning"
      actionsAside
      className="py-2"
      actions={
        <Link
          to="/admin/o/$orgId/plan"
          params={{ orgId }}
          className="text-sm font-medium text-fg-strong underline underline-offset-2"
        >
          Plan
        </Link>
      }
    >
      {worst.label}: {formatCount(worst.used ?? 0)} of {formatCount(worst.limit)}
      {more > 0 ? `, and ${more} more` : ''}
    </Callout>
  );
}
