import { errorMessage } from '@/web/lib/errors.ts';
import { Button, Callout } from '@/web/ui/index.ts';
import { useSaveSettings } from '../settings/queries.ts';

/** Shown while the server has turned PIN-only sign-in off after repeated wrong PINs. */
export function StaffPinOnlyNotice({
  orgId,
  canTurnOn,
  onTurnedOn,
}: {
  orgId: string;
  canTurnOn: boolean;
  onTurnedOn: () => void;
}) {
  const save = useSaveSettings(`org:${orgId}`);
  return (
    <Callout
      tone="warning"
      actionsAside
      actions={
        canTurnOn ? (
          <Button
            size="sm"
            loading={save.isPending}
            onClick={() => save.mutate({ 'scan.pinOnly': true }, { onSuccess: onTurnedOn })}
          >
            Turn on
          </Button>
        ) : undefined
      }
    >
      {save.isError ? errorMessage(save.error) : 'PIN-only sign-in off after repeated wrong PINs.'}
    </Callout>
  );
}
