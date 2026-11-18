import { Nfc, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import { ASSIGN_TIMING } from '../machine/assign-state.ts';
import { countdown } from '../machine/assign-view.ts';
import { fill } from '../ui/copy.ts';
import '../assign/assign.css';

function useSecond(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** The capsule chip while Assign tag is open (× cancels) or while a request waits (tap opens it). */
export function AssignChip({
  mode,
  holderName,
  expiresAt,
  onPress,
}: {
  mode: 'assigning' | 'request-open' | 'request-waiting';
  holderName?: string;
  expiresAt?: number;
  onPress: () => void;
}) {
  const now = useSecond(expiresAt !== undefined);
  const left = expiresAt === undefined ? null : Math.max(0, expiresAt - now);
  const label =
    mode === 'assigning'
      ? SCAN_TAG_COPY.chip.assigning
      : mode === 'request-waiting'
        ? SCAN_TAG_COPY.chip.request
        : fill(SCAN_TAG_COPY.chip.requestFor, { name: holderName?.split(/\s+/)[0] ?? '' });
  return (
    <button
      type="button"
      className="scan-chip"
      data-tone="accent"
      data-slot="request"
      data-new={mode === 'request-waiting' ? '' : undefined}
      data-warn={left !== null && left <= ASSIGN_TIMING.WARN ? '' : undefined}
      data-testid="scan-assign-chip"
      aria-label={mode === 'request-waiting' ? label : `${label}. Cancel`}
      onClick={onPress}
    >
      <Nfc aria-hidden size={14} />
      {label}
      {mode !== 'request-waiting' ? <X aria-hidden size={14} /> : null}
      {left !== null && mode === 'request-open' ? (
        <span aria-live="off">{countdown(expiresAt ?? 0, now)}</span>
      ) : null}
    </button>
  );
}
