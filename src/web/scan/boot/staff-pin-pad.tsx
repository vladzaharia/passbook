import { SCAN_STAFF_COPY as COPY } from '../../../shared/copy/scan-staff.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { PinDots } from '../result/approval-parts.tsx';
import { usePinDraft } from '../result/use-pin-draft.ts';
import { Keypad } from '../ui/keypad.tsx';
import '../result/approval-tray.css';

const LENGTH = 6;
/** A keyed PIN is dropped after this long with no key. */
const IDLE_MS = 30_000;

/** The PIN alone: the server finds the person. The digits live only in `usePinDraft`. */
export function StaffPinPad({
  busy,
  error,
  shake,
  onPin,
  onName,
}: {
  busy: boolean;
  error: string;
  /** Counts refusals: each one restarts the dots' shake. */
  shake: number;
  onPin: (pin: string) => void;
  onName: () => void;
}) {
  const pin = usePinDraft({
    length: LENGTH,
    idleMs: IDLE_MS,
    disabled: busy,
    onFull: onPin,
  });
  return (
    <div className="grid gap-4">
      <p className="scan-pin-title text-center">{COPY.pinLabel}</p>
      <PinDots
        count={busy ? LENGTH : pin.count}
        length={LENGTH}
        shake={shake}
        invalid={error !== ''}
      />
      <Keypad disabled={busy} onDigit={pin.push} onDelete={pin.pop} />
      <div className="min-h-[3.5rem]">
        {error ? <Callout tone="danger">{error}</Callout> : null}
      </div>
      <Button type="button" variant="ghost" disabled={busy} onClick={onName}>
        {COPY.notYou}
      </Button>
    </div>
  );
}
