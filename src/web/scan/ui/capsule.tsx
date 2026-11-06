import { Ellipsis } from 'lucide-react';
import type { ReactNode, Ref } from 'react';

export type CapsuleState = 'scanning' | 'checking' | 'offline' | 'paused';

const STATE_TEXT: Record<CapsuleState, string> = {
  scanning: 'Scanning',
  checking: 'Checking…',
  offline: 'Scanning offline',
  paused: 'Paused',
};

/**
 * The glass capsule: `[Scanner name · staff]` over `[state]`, chips, and the menu trigger. It
 * draws above the tint (z 20), under the ring. Tapping the title opens This shift.
 */
export function Capsule({
  name,
  staff,
  state,
  chips,
  menu,
  onTitle,
}: {
  name: string;
  staff?: string | null;
  state: CapsuleState;
  /** Chips in order: Test, Ready, Reader, Sync, Count. */
  chips?: ReactNode;
  /** The ⋯ trigger (ScanMenu). */
  menu?: ReactNode;
  onTitle?: () => void;
}) {
  return (
    <header className="scan-capsule" data-testid="scan-capsule">
      <button type="button" className="scan-capsule-title" onClick={onTitle}>
        <span className="scan-capsule-name">
          {name}
          {staff ? <span> · {staff}</span> : null}
        </span>
        <span className="scan-capsule-state" data-state={state}>
          <span className="scan-dot" />
          {STATE_TEXT[state]}
        </span>
      </button>
      <div className="scan-chips">{chips}</div>
      {menu}
    </header>
  );
}

export function MenuTrigger({
  ref,
  ...props
}: { ref?: Ref<HTMLButtonElement> } & Record<string, unknown>) {
  return (
    <button ref={ref} type="button" className="scan-icon-btn" aria-label="Menu" {...props}>
      <Ellipsis aria-hidden size={22} />
    </button>
  );
}
