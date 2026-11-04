import type { PassDevicesDto } from '@/shared/contracts/events.ts';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { Callout } from '../../../ui/index.ts';

/** "Removed on 1 of 2 devices": a device counts once it fetched the final version or deleted the pass. */
export function RemovalProgress({ removal }: { removal: NonNullable<PassDevicesDto['removal']> }) {
  const { done, total } = removal;
  const complete = total > 0 && done === total;
  return (
    <Callout tone={complete ? 'success' : 'info'} icon={ACTION_ICON.removeFromWallet}>
      <div className="grid gap-2">
        <p className="font-medium text-fg-strong tabular-nums">
          {total === 0
            ? 'No device had the pass'
            : `Removed on ${done} of ${total} ${total === 1 ? 'device' : 'devices'}`}
        </p>
        {total > 0 ? (
          <div
            role="progressbar"
            aria-label="Devices updated"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            className="h-1.5 overflow-hidden rounded-full bg-surface-sunken"
          >
            <div
              className="h-full origin-left rounded-full bg-success transition-transform duration-300 motion-reduce:transition-none"
              style={{ transform: `scaleX(${done / total})` }}
            />
          </div>
        ) : null}
        <p>The pass moves to Expired passes in Wallet, and the holder can delete it there.</p>
      </div>
    </Callout>
  );
}
