import { Dialog, DialogContent } from '@/web/ui/index.ts';
import { CertificatesTable, RunsTable } from './apple/identity-history.tsx';

/** Runs and certificates of the organization's Apple identity. */
export function OrgAppleHistory({
  orgId,
  identityId,
  identifier,
  open,
  onOpenChange,
}: {
  orgId: string;
  identityId: string | undefined;
  identifier: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Apple history" size="lg">
        <div className="flex flex-col gap-6 overflow-y-auto">
          <RunsTable orgId={orgId} canCancel={false} />
          {identityId ? (
            <CertificatesTable identityId={identityId} identifier={identifier} canRevoke={false} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
