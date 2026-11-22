import { BadgeCheck, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { PASS_FIX_COPY } from '@/shared/copy/pass-setup-fix.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { cn } from '@/web/lib/cn.ts';
import { formatDay } from '@/web/lib/format.ts';
import {
  Card,
  CardBody,
  CardHeader,
  Dialog,
  DialogContent,
  DropdownMenuItem,
  ErrorState,
  MoreMenu,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { usePassSetup } from '../../brand/api.ts';
import { CertificatesTable } from '../../wallet-accounts/apple/identity-history.tsx';
import {
  isManaged,
  ManagedMenuItems,
  RenewButton,
  StopNewPassesDialog,
} from '../../wallet-accounts/apple/managed-actions.tsx';
import { useIdentity } from '../../wallet-accounts/apple/queries.ts';

const COPY = PASS_SETUP_COPY.channelsCard;
const KINDS = PASS_SETUP_COPY.identityKinds;
const FIX = PASS_FIX_COPY.platform;

/** A managed identity's platform actions: Renew now, Pause auto-renew, Stop new passes, certificates. */
function Actions({ identityId }: { identityId: string }) {
  const query = useIdentity(identityId);
  const [stopping, setStopping] = useState(false);
  const [certs, setCerts] = useState(false);
  const identity = query.data;
  if (!identity) return null;
  return (
    <div className="flex items-center gap-2">
      {isManaged(identity) ? <RenewButton identity={identity} /> : null}
      <MoreMenu>
        {isManaged(identity) ? (
          <ManagedMenuItems identity={identity} onStopNewPasses={() => setStopping(true)} />
        ) : null}
        <DropdownMenuItem onSelect={() => setCerts(true)}>{FIX.certificates}</DropdownMenuItem>
      </MoreMenu>
      <StopNewPassesDialog identity={identity} open={stopping} onOpenChange={setStopping} />
      <Dialog open={certs} onOpenChange={setCerts}>
        <DialogContent title={FIX.certificates} size="lg">
          <div className="overflow-y-auto">
            <CertificatesTable
              identityId={identity.id}
              identifier={identity.passTypeIdentifier}
              canRevoke
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** What the org's Apple passes sign with, and the platform's controls over it. */
export function PlatformAppleCard({ orgId }: { orgId: string }) {
  const setup = usePassSetup(orgId);
  const apple = setup.data?.apple;
  const identity = apple?.identity;
  return (
    <Card>
      <CardHeader title={FIX.appleId} />
      <CardBody>
        {setup.isPending ? (
          <SkeletonRows rows={1} label="Loading Apple ID" />
        ) : !apple ? (
          <ErrorState inline error={setup.error} onRetry={() => void setup.refetch()} />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span
              aria-hidden
              className={cn(
                'inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border-strong text-fg-muted',
                identity && 'border-success-border bg-success-subtle text-success',
              )}
            >
              {identity ? <BadgeCheck className="size-5" /> : <ShieldCheck className="size-5" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="break-all font-mono text-sm text-fg-strong">
                {identity?.identifier ?? apple.sharedIdentifier}
              </p>
              <p className="text-xs text-fg-muted">
                {identity ? KINDS[identity.kind] : `${KINDS.platform} · ${FIX.sharedNote}`}
                {identity?.notAfter
                  ? ` · ${scanLine(COPY.renews, { date: formatDay(identity.notAfter) })}`
                  : ''}
                {identity ? ` · ${COPY.push[apple.push]}` : ''}
                {identity && apple.passesOnShared > 0
                  ? ` · ${scanLine(COPY.olderPasses, { n: apple.passesOnShared })}`
                  : ''}
              </p>
            </div>
            {identity ? <Actions identityId={identity.id} /> : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
