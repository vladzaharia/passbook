import { Check } from 'lucide-react';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import type { OrgPlanDto } from '@/shared/contracts/org-plan.ts';
import { PLAN_COPY } from '@/shared/copy/plans.ts';
import { formatCount } from '@/web/lib/format.ts';
import {
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  PageHeader,
  ProgressBar,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { FooterSample, PlanFooterInfo } from '../orgs/features/plan-footer-popover.tsx';
import { planIcon } from '../orgs/features/plan-icons.ts';
import { featureLabel, type LimitRow, limitRows } from './limits.ts';
import { useOrgPlan } from './queries.ts';

const NO_PLAN = 'No plan on this organization.';

function valueText(r: LimitRow): string {
  if (r.limit === null)
    return r.used === null ? PLAN_COPY.noLimit : `${formatCount(r.used)} · ${PLAN_COPY.noLimit}`;
  return r.used === null
    ? formatCount(r.limit)
    : `${formatCount(r.used)} of ${formatCount(r.limit)}`;
}

function Limits({ rows }: { rows: LimitRow[] }) {
  return (
    <Card aria-labelledby="plan-limits">
      <CardHeader title={<span id="plan-limits">Limits</span>} />
      <CardBody>
        <dl className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
          {rows.map((r) => (
            <div key={r.key} className="flex min-w-0 flex-col gap-1.5">
              <dt className="text-xs text-fg-muted">{r.label}</dt>
              <dd className="flex flex-col gap-1.5">
                <span
                  className={`text-sm tabular-nums ${r.state === 'ok' ? 'text-fg-strong' : 'font-medium text-warning'}`}
                >
                  {valueText(r)}
                </span>
                {r.limit !== null && r.used !== null ? (
                  <ProgressBar
                    label={r.label}
                    value={r.used}
                    max={r.limit}
                    valueText={valueText(r)}
                    tone={r.state === 'ok' ? 'accent' : 'warning'}
                  />
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}

function Features({ plan }: { plan: OrgPlanDto }) {
  return (
    <Card aria-labelledby="plan-features">
      <CardHeader title={<span id="plan-features">Features</span>} />
      <CardBody>
        <ul className="grid gap-x-10 gap-y-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {plan.features.map((f) => (
            <li key={f.key} className="flex items-center gap-2 text-sm text-fg-strong">
              <Check aria-hidden className="size-4 shrink-0 text-success" />
              {featureLabel(f)}
            </li>
          ))}
        </ul>
        <div className="mt-5 flex min-h-9 items-center justify-between gap-2 border-t border-border pt-3 text-xs text-fg-muted">
          <span>
            <span className="sr-only">{PLAN_COPY.footerLead} </span>
            <FooterSample level={plan.footer} />
          </span>
          <PlanFooterInfo plan={plan.label ?? ''} level={plan.footer} audience="org" />
        </div>
      </CardBody>
    </Card>
  );
}

/** The organization's plan: its limits with use and the features it can use. Read only; PassBook changes it. */
export function PlanPage({ orgId, membership }: { orgId: string; membership: OrgMembership }) {
  const query = useOrgPlan(orgId);
  const plan = query.data;
  const Icon = plan?.preset ? planIcon(plan.preset) : null;
  return (
    <>
      <PageHeader
        title={PLAN_COPY.title}
        breadcrumbs={[{ label: membership.orgName }, { label: PLAN_COPY.title }]}
      />
      {query.isPending ? (
        <SkeletonRows label="Loading plan" />
      ) : query.isError || !plan ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : plan.label === null ? (
        <p className="text-sm text-fg-muted">{NO_PLAN}</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          <h2 className="flex items-center gap-2.5 text-xl font-semibold text-fg-strong">
            {Icon ? <Icon aria-hidden className="size-6 text-fg-muted" /> : null}
            {plan.label}
          </h2>
          <Limits rows={limitRows(plan)} />
          <Features plan={plan} />
        </div>
      )}
    </>
  );
}
