import { useEffect, useState } from 'react';
import type { ScanOutcome } from '../machine/types.ts';
import { useScanMachine } from '../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import { DockButton, DoorThumbRow } from './dock.tsx';

export function DoorDock({
  outcome,
  runtime,
  open,
  onError,
}: {
  outcome: ScanOutcome | null;
  runtime: ScanRuntime;
  open: (sheet: boolean) => void;
  onError: (message: string) => void;
}) {
  const { state, dispatch } = useScanMachine();
  const [torch, setTorch] = useState(false);
  useEffect(() => {
    if (state.camera !== 'live') setTorch(false);
  }, [state.camera]);
  if (!outcome || (outcome.kind === 'ok' && !state.prefs.holdResults))
    return (
      <DoorThumbRow
        canTorch={runtime.camera.hasTorch()}
        torchOn={torch}
        onTorch={() => {
          void runtime.camera
            .toggleTorch()
            .then(setTorch, () => onError('Torch unavailable. Check camera access.'));
        }}
        onLookUp={() => open(true)}
      />
    );
  const override = outcome.overridable && outcome.action;
  const check = outcome.reason === 'check_required' && outcome.action;
  return (
    <>
      {override || check ? (
        <DockButton
          onClick={() => dispatch({ type: 'override', actionId: outcome.action?.id ?? '' })}
        >
          {check ? 'Check in' : 'Let in again'}
        </DockButton>
      ) : null}
      <DockButton
        primary
        variant="filled"
        shape={override || check ? 'fixed' : undefined}
        onClick={() => dispatch({ type: 'dismiss' })}
      >
        Done
      </DockButton>
    </>
  );
}
