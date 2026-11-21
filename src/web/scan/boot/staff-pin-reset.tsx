import { useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { SCAN_STAFF_COPY as COPY } from '../../../shared/copy/scan-staff.ts';
import { errorMessage } from '../../lib/errors.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { PinDots } from '../result/approval-parts.tsx';
import { usePinDraft } from '../result/use-pin-draft.ts';
import { BootCard } from '../ui/boot-card.tsx';
import { Keypad } from '../ui/keypad.tsx';
import { issuedPins } from './pin-reset-state.ts';
import '../result/approval-tray.css';

const LENGTH = 6;
const IDLE_MS = 30_000;
type Phase = 'show' | 'confirm';

/** A shared PIN was seen: the server sets a new one, the person reads it once and types it back. */
export function StaffPinReset({
  session,
  api,
  refetch,
}: {
  session: ScanSession;
  api: Pick<ScanApi, 'staffNewPin' | 'staffSignOut'>;
  refetch: () => Promise<void>;
}) {
  const id = session.staff?.id ?? '';
  const [phase, setPhase] = useState<Phase>('show');
  const [, redraw] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refusals, setRefusals] = useState(0);
  const pinNow = issuedPins.get(id);
  async function get() {
    setBusy(true);
    setError('');
    try {
      const done = await api.staffNewPin();
      issuedPins.set(id, done.pin);
      setPhase('show');
      redraw((n) => n + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    try {
      await api.staffSignOut();
      issuedPins.delete(id);
      await refetch();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function onFull(digits: string) {
    if (digits === pinNow) {
      issuedPins.delete(id);
      setBusy(true);
      try {
        await refetch();
      } finally {
        setBusy(false);
      }
      return;
    }
    setError(COPY.resetWrong);
    setRefusals((n) => n + 1);
  }
  const pin = usePinDraft({
    length: LENGTH,
    idleMs: IDLE_MS,
    disabled: busy || phase !== 'confirm',
    onFull,
  });
  return (
    <BootCard title={COPY.resetTitle} line={session.staff?.name ?? null}>
      {pinNow === undefined ? (
        <div className="grid gap-4">
          <p className="scan-pin-title text-center">{COPY.resetFirst}</p>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Button type="button" loading={busy} onClick={() => void get()}>
            {COPY.resetGet}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void signOut()}>
            {COPY.signOut}
          </Button>
        </div>
      ) : phase === 'show' ? (
        <div className="grid gap-4">
          <p className="scan-pin-title text-center">{COPY.resetShown}</p>
          <p
            data-testid="new-pin"
            className="text-center text-5xl font-bold tabular-nums tracking-[0.2em] text-fg-strong"
          >
            {pinNow}
          </p>
          <Button
            type="button"
            onClick={() => {
              setError('');
              setPhase('confirm');
            }}
          >
            {COPY.resetReady}
          </Button>
        </div>
      ) : (
        <div className="grid gap-4">
          <p className="scan-pin-title text-center">{COPY.resetTypeBack}</p>
          <PinDots
            count={busy ? LENGTH : pin.count}
            length={LENGTH}
            shake={refusals}
            invalid={error !== ''}
          />
          <Keypad disabled={busy} onDigit={pin.push} onDelete={pin.pop} />
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setPhase('show')}>
            {COPY.resetShowAgain}
          </Button>
        </div>
      )}
    </BootCard>
  );
}
