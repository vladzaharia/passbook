import { useEffect, useState } from 'react';
import { holdVerbs } from '../machine/access-view.ts';
import type { ScanOutcome } from '../machine/types.ts';
import { useScanMachine } from '../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import { DockButton, DoorThumbRow } from './dock.tsx';

export function DoorDock({
  outcome,
  runtime,
  open,
  onError,
  inside,
}: {
  outcome: ScanOutcome | null;
  runtime: ScanRuntime;
  open: (sheet: boolean) => void;
  onError: (message: string) => void;
  inside?: { count: number; onOpen: () => void };
}) {
  const { state, dispatch } = useScanMachine();
  const [torch, setTorch] = useState(false);
  useEffect(() => {
    if (state.camera !== 'live') setTorch(false);
  }, [state.camera]);
  if (!outcome || (outcome.kind === 'ok' && !state.prefs.holdResults))
    return (
      <DoorThumbRow
        {...(inside ? { inside } : {})}
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
  const check = outcome.reason === 'check_required' && outcome.action;
  const verbs = check ? [] : holdVerbs(outcome);
  const more = Boolean(check) || verbs.length > 0;
  return (
    <>
      {check ? (
        <DockButton
          onClick={() => dispatch({ type: 'override', actionId: outcome.action?.id ?? '' })}
        >
          Check in
        </DockButton>
      ) : null}
      {verbs.map((verb) => (
        <DockButton
          key={verb.label}
          data-testid={verb.kind === 'turn' ? `dock-tap-${verb.direction}` : 'dock-let-in'}
          onClick={() =>
            verb.kind === 'turn'
              ? dispatch({ type: 'turn', direction: verb.direction })
              : dispatch({ type: 'override', actionId: outcome.action?.id ?? '' })
          }
        >
          {verb.label}
        </DockButton>
      ))}
      <DockButton
        primary
        variant="filled"
        shape={more ? 'fixed' : undefined}
        onClick={() => dispatch({ type: 'dismiss' })}
      >
        Done
      </DockButton>
    </>
  );
}
