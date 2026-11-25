import { Nfc } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import { TAG_EXTRA_COPY } from '../assign/copy.ts';
import { holdVerbs } from '../machine/access-view.ts';
import type { ShownDirection } from '../machine/direction-view.ts';
import { groupAction } from '../machine/group-view.ts';
import type { ScanOutcome } from '../machine/types.ts';
import { useScanMachine } from '../machine/use-scan-machine.ts';
import type { ScanRuntime } from '../platform/runtime.ts';
import { ApprovalDock, type DockApproval } from './approval-dock.tsx';
import { DirectionButton } from './direction-button.tsx';
import { DockButton, DoorThumbRow } from './dock.tsx';
import { GroupDock } from './group-dock.tsx';

export function DoorDock({
  outcome,
  runtime,
  open,
  onError,
  inside,
  tags,
  approval,
  approving = false,
  handheld = false,
  direction,
}: {
  outcome: ScanOutcome | null;
  /** The phone's dock: a bundle's Check in more lives here, not in the card. */
  handheld?: boolean;
  /** The way this scanner reads; `onCycle` only on a Both scanner. */
  direction?: { value: ShownDirection; onCycle?: () => void } | undefined;
  runtime: ScanRuntime;
  open: (sheet: boolean) => void;
  onError: (message: string) => void;
  inside?: { count: number; onOpen: () => void };
  /** A handheld: a `needs_approval` hold offers the Manager PIN tray here, not on the card. */
  approval?: DockApproval | undefined;
  /** The PIN is with the server. */
  approving?: boolean;
  /** Tags: Tap to read (iPhone), Add tag on a result, Assign tag on an unknown tag. */
  tags?: {
    tapToRead: (() => void) | null;
    addTag: (() => void) | null;
    assignUnknown: (() => void) | null;
  };
}) {
  const { state, dispatch } = useScanMachine();
  const [torch, setTorch] = useState(false);
  useEffect(() => {
    if (state.camera !== 'live') setTorch(false);
  }, [state.camera]);
  // Check in more is for entry: an Out door has no group to let in.
  const group = handheld && outcome && direction?.value !== 'out' ? groupAction(outcome) : null;
  if (group) return <GroupDock label={group.label} />;
  if (!outcome || (outcome.kind === 'ok' && !state.prefs.holdResults))
    return (
      <DoorThumbRow
        {...(inside ? { inside } : {})}
        {...(tags?.tapToRead ? { tapToRead: tags.tapToRead } : {})}
        {...(handheld && direction?.onCycle
          ? { direction: <DirectionButton value={direction.value} onCycle={direction.onCycle} /> }
          : {})}
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
  if (approval && outcome.reason === 'needs_approval')
    return <ApprovalDock outcome={outcome} approval={approval} busy={approving} />;
  const check =
    (outcome.reason === 'check_required' || outcome.reason === 'offline_decide') && outcome.action;
  const verbs = check ? [] : holdVerbs(outcome);
  const unknown = tags?.assignUnknown ?? null;
  const more = Boolean(check) || verbs.length > 0 || Boolean(unknown) || Boolean(tags?.addTag);
  return (
    <>
      {unknown ? (
        <DockButton primary variant="filled" data-testid="scan-assign-unknown" onClick={unknown}>
          <Nfc aria-hidden size={20} />
          {SCAN_TAG_COPY.menu.assign}
        </DockButton>
      ) : null}
      {tags?.addTag ? (
        <DockButton data-testid="scan-add-tag" onClick={tags.addTag}>
          <Nfc aria-hidden size={20} />
          {TAG_EXTRA_COPY.addTag}
        </DockButton>
      ) : null}
      {check ? (
        <DockButton
          onClick={() => dispatch({ type: 'override', actionId: outcome.action?.id ?? '' })}
        >
          {outcome.action?.label ?? 'Continue'}
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
        primary={!unknown}
        variant={unknown ? 'gray' : 'filled'}
        shape={more ? 'fixed' : undefined}
        onClick={() => dispatch({ type: 'dismiss' })}
      >
        Done
      </DockButton>
    </>
  );
}
