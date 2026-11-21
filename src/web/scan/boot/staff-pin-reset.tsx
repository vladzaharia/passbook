import { useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { SCAN_STAFF_COPY as COPY } from '../../../shared/copy/scan-staff.ts';
import { errorMessage } from '../../lib/errors.ts';
import { Callout } from '../../ui/callout.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { PinDots } from '../result/approval-parts.tsx';
import { usePinDraft } from '../result/use-pin-draft.ts';
import { BootCard } from '../ui/boot-card.tsx';
import { Keypad } from '../ui/keypad.tsx';
import '../result/approval-tray.css';

const LENGTH = 6;
const IDLE_MS = 30_000;

/** A shared PIN was seen: the signed-in person keys a new one twice before they go on. */
export function StaffPinReset({
  session,
  api,
  refetch,
}: {
  session: ScanSession;
  api: Pick<ScanApi, 'staffSetPin'>;
  refetch: () => Promise<void>;
}) {
  // The first entry waits in a closure only; it is dropped as soon as the second is keyed.
  const [first, setFirst] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refusals, setRefusals] = useState(0);
  const refuse = (message: string) => {
    setError(message);
    setRefusals((n) => n + 1);
  };
  async function onFull(digits: string) {
    if (first === null) {
      setError('');
      setFirst(digits);
      return;
    }
    if (digits !== first) {
      setFirst(null);
      refuse(COPY.resetMismatch);
      return;
    }
    setBusy(true);
    try {
      await api.staffSetPin(digits);
      await refetch();
    } catch (cause) {
      setFirst(null);
      refuse(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const pin = usePinDraft({ length: LENGTH, idleMs: IDLE_MS, disabled: busy, onFull });
  return (
    <BootCard title={COPY.resetTitle} line={session.staff?.name ?? null}>
      <div className="grid gap-4">
        <p className="scan-pin-title text-center">
          {first === null ? COPY.resetFirst : COPY.resetAgain}
        </p>
        <PinDots
          count={busy ? LENGTH : pin.count}
          length={LENGTH}
          shake={refusals}
          invalid={error !== ''}
        />
        <Keypad disabled={busy} onDigit={pin.push} onDelete={pin.pop} />
        {error ? <Callout tone="danger">{error}</Callout> : null}
      </div>
    </BootCard>
  );
}
