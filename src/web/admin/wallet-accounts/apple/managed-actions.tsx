import { CirclePause, CirclePlay, OctagonX, RefreshCw } from 'lucide-react';
import type { z } from 'zod';
import type { IdentitySchema } from '@/shared/contracts/identities.ts';
import { Button, ConfirmDialog, DropdownMenuItem, toast } from '@/web/ui/index.ts';
import { useRenewIdentity } from './managed-queries.ts';
import { useUpdateIdentity } from './queries.ts';

type Identity = z.infer<typeof IdentitySchema>;

/** A managed identity renews itself; these act on that. */
export const isManaged = (identity: Identity) => identity.kind === 'managed';

export function RenewButton({ identity }: { identity: Identity }) {
  const renew = useRenewIdentity(identity.id);
  return (
    <Button
      variant="outline"
      iconStart={<RefreshCw aria-hidden />}
      loading={renew.isPending}
      disabled={identity.rotation !== 'auto' || identity.certSha256 === null}
      onClick={() =>
        renew.mutate(undefined, {
          onSuccess: () => toast.success('Renewal started'),
          onError: (cause) => toast.error(cause, 'Could not start the renewal'),
        })
      }
    >
      Renew now
    </Button>
  );
}

export function ManagedMenuItems({
  identity,
  onStopNewPasses,
}: {
  identity: Identity;
  onStopNewPasses: () => void;
}) {
  const update = useUpdateIdentity(identity.id);
  const patch = (body: { rotation?: 'auto' | 'manual'; issuing?: boolean }, done: string) =>
    update.mutate(body, {
      onSuccess: () => toast.success(done),
      onError: (cause) => toast.error(cause, 'Could not save'),
    });
  return (
    <>
      {identity.rotation === 'auto' ? (
        <DropdownMenuItem onSelect={() => patch({ rotation: 'manual' }, 'Auto-renew paused')}>
          <CirclePause aria-hidden />
          Pause auto-renew
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={() => patch({ rotation: 'auto' }, 'Auto-renew on')}>
          <CirclePlay aria-hidden />
          Resume auto-renew
        </DropdownMenuItem>
      )}
      {identity.issuing ? (
        <DropdownMenuItem onSelect={onStopNewPasses}>
          <OctagonX aria-hidden />
          Stop new passes
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={() => patch({ issuing: true }, 'New passes allowed')}>
          <CirclePlay aria-hidden />
          Allow new passes
        </DropdownMenuItem>
      )}
    </>
  );
}

export function StopNewPassesDialog({
  identity,
  open,
  onOpenChange,
}: {
  identity: Identity;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateIdentity(identity.id);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Stop new passes?"
      description="New passes can't use this ID. Existing passes keep working."
      confirmLabel="Stop new passes"
      destructive
      onConfirm={async () => {
        await update.mutateAsync({ issuing: false });
        toast.success('New passes stopped');
      }}
    />
  );
}
