import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { PLAN_COPY } from '@/shared/copy/plans.ts';
import {
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  PageHeader,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { planIcon } from '../orgs/features/plan-icons.ts';
import { viewOfOrgPlan } from './limits.ts';
import { FeatureChecklist, FooterRow, LimitList } from './plan-parts.tsx';
import { useOrgPlan } from './queries.ts';

const NO_PLAN = 'No plan on this organization.';

/** The organization's plan: its limits with use and the features it can use. Read only; PassBook changes it. */
export function PlanPage({ orgId, membership }: { orgId: string; membership: OrgMembership }) {
  const query = useOrgPlan(orgId);
  const plan = query.data;
  const Icon = plan?.preset ? planIcon(plan.preset) : null;
  const view = plan ? viewOfOrgPlan(plan) : null;
  return (
    <>
      <PageHeader
        title={PLAN_COPY.title}
        breadcrumbs={[{ label: membership.orgName }, { label: PLAN_COPY.title }]}
      />
      {query.isPending ? (
        <SkeletonRows label="Loading plan" />
      ) : query.isError || !plan || !view ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : plan.label === null ? (
        <p className="text-sm text-fg-muted">{NO_PLAN}</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          <h2 className="flex items-center gap-3 text-xl font-semibold text-fg-strong">
            {Icon ? (
              <span
                aria-hidden
                className="inline-flex size-10 items-center justify-center rounded-lg border border-border bg-surface-sunken text-accent-fg"
              >
                <Icon className="size-5" />
              </span>
            ) : null}
            {plan.label}
          </h2>
          <Card aria-labelledby="plan-limits">
            <CardHeader title={<span id="plan-limits">{PLAN_COPY.limits}</span>} />
            <CardBody>
              <LimitList rows={view.limits} />
            </CardBody>
          </Card>
          <Card aria-labelledby="plan-features">
            <CardHeader title={<span id="plan-features">{PLAN_COPY.features}</span>} />
            <CardBody className="flex flex-col gap-5">
              <FeatureChecklist items={view.features} />
              <FooterRow level={view.footer} />
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
