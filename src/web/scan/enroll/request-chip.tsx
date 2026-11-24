import { Nfc, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import { ASSIGN_TIMING } from '../machine/assign-state.ts';
import { countdown } from '../machine/assign-view.ts';
import { fill } from '../ui/copy.ts';
import '../assign/assign.css';
import '../assign/tag-chrome.css';

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
  const timer = left !== null && mode === 'request-open' ? countdown(expiresAt ?? 0, now) : null;
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
      onClick={onPress}
    >
      <Nfc aria-hidden size={14} />
      {label}
      {mode !== 'request-waiting' ? <X aria-hidden size={14} /> : null}
      {timer ? <span aria-live="off">{timer}</span> : null}
      {/* The chip's name is its visible text (label in name); Cancel follows it for a screen reader. */}
      {mode !== 'request-waiting' ? <span className="scan-sr">Cancel</span> : null}
    </button>
  );
}
