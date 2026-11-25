import { Link } from '@tanstack/react-router';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { RETENTION_COPY } from '@/shared/copy/retention.ts';
import { formatDayIn } from '@/web/lib/format.ts';
import { Button, Callout, PageHeader, SaveBarGroup } from '@/web/ui/index.ts';
import { useSettings } from '../settings/queries.ts';
import { HoldsCard } from './holds-card.tsx';
import { useHolds } from './queries.ts';
import { ReceiptsCard } from './receipts-card.tsx';
import { WindowsCard } from './windows-card.tsx';

/** Retention for one organization: windows, legal holds and receipts. Mounted after the org gate. */
export function RetentionPage({ orgId, membership }: { orgId: string; membership: OrgMembership }) {
  const can = (c: OrgMembership['capabilities'][number]) => membership.capabilities.includes(c);
  const canAudit = can('audit:read');
  const holds = useHolds('org', orgId, canAudit);
  const held = holds.data?.items.some((h) => h.releasedAt === null) ?? false;
  const zone = useSettings(`org:${orgId}`).data?.items.find((i) => i.key === 'org.timeZone')?.value;
  const from = holds.data?.guestPassesFrom;
  return (
    <SaveBarGroup>
      <PageHeader
        title={RETENTION_COPY.title}
        actions={
          canAudit ? (
            <Button asChild variant="outline">
              <Link to="/admin/o/$orgId/audit" params={{ orgId }}>
                Audit log
              </Link>
            </Button>
          ) : undefined
        }
      />
      <div className="flex min-w-0 flex-col gap-6">
        {from ? (
          <Callout tone="info">
            {RETENTION_COPY.guestGrace(
              formatDayIn(from, typeof zone === 'string' && zone ? zone : 'America/Los_Angeles'),
            )}
          </Callout>
        ) : null}
        {held ? <Callout tone="warning">{RETENTION_COPY.heldBanner}</Callout> : null}
        <WindowsCard orgId={orgId} canManage={can('org:manage')} />
        {canAudit ? (
          <>
            <HoldsCard scope="org" orgId={orgId} canManage={can('org:manage')} />
            <ReceiptsCard scope="org" orgId={orgId} />
          </>
        ) : null}
      </div>
    </SaveBarGroup>
  );
}
