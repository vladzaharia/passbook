import { Lock, Unlock } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { HoldSchema } from '@/shared/contracts/retention.ts';
import { RETENTION_COPY } from '@/shared/copy/retention.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  ListRow,
  ListRows,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { PlaceHoldDialog } from './place-hold-dialog.tsx';
import { type RetentionScope, useHolds } from './queries.ts';
import { ReleaseHoldDialog } from './release-hold-dialog.tsx';

type Hold = z.infer<typeof HoldSchema>;

function HoldRow({
  hold,
  canManage,
  onRelease,
}: {
  hold: Hold;
  canManage: boolean;
  onRelease: (hold: Hold) => void;
}) {
  const active = hold.releasedAt === null;
  const meta = [
    hold.reason,
    `${hold.placedByKind === 'platform' ? 'Placed by PassBook' : `Placed by ${hold.placedByLabel}`}, ${formatDateTime(hold.createdAt)}`,
    hold.releasedAt === null
      ? null
      : `Released by ${hold.releasedByLabel ?? 'PassBook'}, ${formatDateTime(hold.releasedAt)}`,
  ].filter(Boolean);
  return (
    <ListRow
      rowId={hold.id}
      leading={active ? <Lock aria-hidden /> : <Unlock aria-hidden />}
      title={hold.passLabel ?? 'Whole organization'}
      pills={
        <>
          <Badge tone={active ? 'warning' : 'neutral'}>{active ? 'Active' : 'Released'}</Badge>
          {hold.placedByKind === 'platform' ? <Badge tone="info">PassBook</Badge> : null}
        </>
      }
      meta={meta.join(' · ')}
      trailing={
        active && canManage && hold.canRelease ? (
          <Button variant="outline" size="sm" onClick={() => onRelease(hold)}>
            {RETENTION_COPY.release}
          </Button>
        ) : null
      }
    />
  );
}

/**
 * Org pages list the org's holds and let `org:manage` place and release its own; PassBook holds show
 * read-only. Platform pages place holds the org cannot release, and release any.
 */
export function HoldsCard({
  scope,
  orgId,
  canManage,
}: {
  scope: RetentionScope;
  orgId: string;
  canManage: boolean;
}) {
  const query = useHolds(scope, orgId);
  const [placing, setPlacing] = useState(false);
  const [releasing, setReleasing] = useState<Hold>();
  const items = query.data?.items ?? [];
  const platformHeld = items.some((h) => h.releasedAt === null && h.placedByKind === 'platform');
  return (
    <Card>
      <CardHeader
        title={RETENTION_COPY.holdsTitle}
        actions={
          canManage ? (
            <Button variant="outline" size="sm" onClick={() => setPlacing(true)}>
              {RETENTION_COPY.place}
            </Button>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-4">
        {platformHeld && scope === 'org' ? (
          <Callout tone="info">{RETENTION_COPY.platformHold}</Callout>
        ) : null}
        {query.isPending ? (
          <SkeletonRows rows={2} label="Loading holds" />
        ) : query.isError ? (
          <ErrorState subject="holds" error={query.error} onRetry={() => query.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState inline art="lock" mood="flat" title={RETENTION_COPY.noHolds} />
        ) : (
          <ListRows label="Legal holds">
            {items.map((hold) => (
              <HoldRow key={hold.id} hold={hold} canManage={canManage} onRelease={setReleasing} />
            ))}
          </ListRows>
        )}
      </CardBody>
      <PlaceHoldDialog scope={scope} orgId={orgId} open={placing} onOpenChange={setPlacing} />
      <ReleaseHoldDialog
        scope={scope}
        orgId={orgId}
        holdId={releasing?.id}
        onClose={() => setReleasing(undefined)}
      />
    </Card>
  );
}
