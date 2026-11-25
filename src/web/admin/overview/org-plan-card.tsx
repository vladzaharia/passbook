import { useQuery } from '@tanstack/react-query';
import { OrgOwnEntitlementsSchema } from '@/shared/contracts/entitlement-admin.ts';
import type { EntitlementKey } from '@/shared/contracts/entitlements.ts';
import { ENTITLEMENT_LABEL, LIMIT_ASK } from '@/shared/copy/entitlements.ts';
import { PLAN_COPY } from '@/shared/copy/plans.ts';
import { planFacts } from '@/shared/plan-facts.ts';
import { api } from '@/web/lib/api.ts';
import { formatCount } from '@/web/lib/format.ts';
import { Card, CardBody, CardHeader, ProgressBar } from '@/web/ui/index.ts';
import { ChannelChips } from '../orgs/features/plan-channels.tsx';
import { FooterSample, PlanFooterInfo } from '../orgs/features/plan-footer-popover.tsx';
import { planIcon } from '../orgs/features/plan-icons.ts';

/** The limits shown with their use; the rest of the plan is on the Features list. */
const METERS: readonly { key: EntitlementKey; label: string }[] = [
  { key: 'passes.live', label: 'Passes' },
  { key: 'templates', label: ENTITLEMENT_LABEL.templates },
  { key: 'scanning.devices', label: 'Scanners' },
  { key: 'members', label: ENTITLEMENT_LABEL.members },
];
/** A meter turns warning at this share of its limit. */
const WARN = 0.8;

const useOwnPlan = (orgId: string) =>
  useQuery({
    queryKey: ['orgs', 'own-entitlements', orgId],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/orgs/${encodeURIComponent(orgId)}/entitlements`, OrgOwnEntitlementsSchema, {
        signal,
      }),
    // A plan changes by hand and use moves slowly; the 80% warning can be minutes late.
    staleTime: 5 * 60_000,
  });

/**
 * The organization's plan: its name, what it has used of each limit, its channels and the PassBook footer
 * it may show. Facts only; there is no billing to link to, so a full meter says to ask PassBook.
 */
export function OrgPlanCard({ orgId, orgName }: { orgId: string; orgName?: string }) {
  const plan = useOwnPlan(orgId);
  const data = plan.data;
  if (!data || data.preset === null || data.label === null) return null;
  const values = Object.fromEntries(data.items.map((i) => [i.key, i.value]));
  const facts = planFacts(values);
  const Icon = planIcon(data.preset);
  // A limit of 0 is a feature the plan does not have: no row, never "0 of 0".
  const limits = METERS.map(({ key, label }) => {
    const limit = values[key];
    const used = data.usage[key] ?? 0;
    const cap = typeof limit === 'number' ? limit : null;
    return { key, label, used, cap, near: cap !== null && cap > 0 && used / cap >= WARN };
  }).filter((m) => m.cap !== 0);
  return (
    <Card aria-label={PLAN_COPY.title}>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Icon aria-hidden className="size-5 text-fg-muted" />
            {data.label}
          </span>
        }
      />
      <CardBody className="flex flex-col gap-4">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {limits.map((m) => (
            <div key={m.key} className="flex flex-col gap-1.5">
              <dt className="text-xs text-fg-muted">{m.label}</dt>
              <dd className="flex flex-col gap-1.5">
                <span className="text-sm text-fg-strong tabular-nums">
                  {m.cap === null
                    ? `${formatCount(m.used)} · ${PLAN_COPY.noLimit}`
                    : `${formatCount(m.used)} of ${formatCount(m.cap)}`}
                </span>
                {m.cap !== null && m.cap > 0 ? (
                  <ProgressBar
                    label={m.label}
                    value={m.used}
                    max={m.cap}
                    valueText={`${formatCount(m.used)} of ${formatCount(m.cap)}`}
                    tone={m.near ? 'warning' : 'accent'}
                  />
                ) : null}
                {m.near ? <span className="text-xs text-warning">{LIMIT_ASK}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
        <ChannelChips facts={facts} onlyIncluded />
        <div className="flex min-h-9 items-center justify-between gap-2 border-t border-border pt-2 text-xs text-fg-muted">
          <span>
            <span className="sr-only">{PLAN_COPY.footerLead} </span>
            <FooterSample level={facts.footer} />
          </span>
          <PlanFooterInfo plan={data.label} level={facts.footer} orgName={orgName} audience="org" />
        </div>
      </CardBody>
    </Card>
  );
}
