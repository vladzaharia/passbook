import { useState } from 'react';
import { RETENTION_COPY } from '@/shared/copy/retention.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Badge, Button } from '@/web/ui/index.ts';
import { PlaceHoldDialog } from '../../retention/place-hold-dialog.tsx';
import { useHolds } from '../../retention/queries.ts';
import { ReleaseHoldDialog } from '../../retention/release-hold-dialog.tsx';

/**
 * The pass's legal hold: its own, or the organization's, or PassBook's. Needs `audit:read` to see;
 * `org:manage` places and releases a hold on this pass (an org-wide or PassBook hold is read-only here).
 */
export function PassHold({ passId, orgId }: { passId: string; orgId: string }) {
  const { membership } = useOrgScope();
  const inOrg = membership?.orgId === orgId ? membership : undefined;
  const canAudit = inOrg?.capabilities.includes('audit:read') ?? false;
  const canManage = inOrg?.capabilities.includes('org:manage') ?? false;
  const holds = useHolds('org', orgId, canAudit);
  const [placing, setPlacing] = useState(false);
  const [releasing, setReleasing] = useState<string>();
  if (!canAudit) return null;
  const active = (holds.data?.items ?? []).filter((h) => h.releasedAt === null);
  const own = active.find((h) => h.passId === passId);
  const wide = active.find((h) => h.passId === null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-fg-muted">
          Legal hold
          {own ? (
            <Badge tone="warning">On this pass</Badge>
          ) : wide ? (
            <Badge tone="warning">
              {wide.placedByKind === 'platform'
                ? 'PassBook, whole organization'
                : 'Whole organization'}
            </Badge>
          ) : (
            <span className="text-fg">None</span>
          )}
        </span>
        {own?.reason ? <span className="text-xs text-fg-muted">{own.reason}</span> : null}
      </div>
      {canManage && own?.canRelease ? (
        <Button variant="outline" size="sm" onClick={() => setReleasing(own.id)}>
          {RETENTION_COPY.release}
        </Button>
      ) : canManage && !own ? (
        <Button variant="outline" size="sm" onClick={() => setPlacing(true)}>
          {RETENTION_COPY.place}
        </Button>
      ) : null}
      <PlaceHoldDialog
        scope="org"
        orgId={orgId}
        passId={passId}
        open={placing}
        onOpenChange={setPlacing}
      />
      <ReleaseHoldDialog
        scope="org"
        orgId={orgId}
        holdId={releasing}
        onClose={() => setReleasing(undefined)}
      />
    </div>
  );
}
