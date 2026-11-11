import { useQuery } from '@tanstack/react-query';
import type { ScanningDevice } from '@/shared/contracts/scanning-sessions.ts';
import { revokeScannerConfirm } from '@/web/lib/confirms.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { Button, ConfirmDialog, Dialog, DialogContent, detailError } from '@/web/ui/index.ts';
import { SCANNERS_POLL_MS, scannerQuery } from '../queries.ts';
import { PairDialog } from '../scanners/scanner-dialogs.tsx';
import { useRevokeSessionDevice } from './api.ts';

export function SessionPairDialog({
  id,
  orgId,
  sessionId,
  onClose,
}: {
  id: string;
  orgId: string;
  sessionId: string;
  onClose: () => void;
}) {
  const query = useQuery({ ...scannerQuery(id, SCANNERS_POLL_MS), refetchOnMount: 'always' });
  if (
    (query.isFetchedAfterMount &&
      query.data &&
      (query.data.orgId !== orgId || query.data.sessionId !== sessionId)) ||
    (query.isError && isApiError(query.error) && query.error.isNotFound)
  ) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent title="Scanner not found">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogContent>
      </Dialog>
    );
  }
  if (query.isError) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent title="Scanner">
          {detailError(query, { entity: 'scanner', to: '/admin/scanning', back: 'scanning' })}
        </DialogContent>
      </Dialog>
    );
  }
  if (!query.isFetchedAfterMount || !query.data) return null;
  return <PairDialog scanner={query.data} onClose={onClose} />;
}

export function SessionRevokeDialog({
  device,
  onClose,
}: {
  device: ScanningDevice;
  onClose: () => void;
}) {
  const revoke = useRevokeSessionDevice(device.id);
  return (
    <ConfirmDialog
      open
      {...revokeScannerConfirm(device.name)}
      destructive
      onOpenChange={(open) => !open && onClose()}
      onConfirm={async () => {
        await revoke.mutateAsync();
        onClose();
      }}
    />
  );
}
