import { Ellipsis } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { ScanOrgLogo } from '../platform/scan-branding.tsx';

export type CapsuleState = 'scanning' | 'checking' | 'offline' | 'paused' | 'ready';

const STATE_TEXT: Record<CapsuleState, string> = {
  scanning: 'Scanning',
  checking: 'Checking…',
  offline: 'Offline',
  paused: 'Paused',
  ready: 'Ready',
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
  logoUrl,
  orgName = '',
  mode,
  direction,
}: {
  /** The device's mode, shown beside the state. */
  mode?: string;
  /** The way it reads, after the state: Scanning · Out. A handheld's word; the chip does it elsewhere. */
  direction?: string;
  name: string;
  staff?: string | null;
  state: CapsuleState;
  chips?: ReactNode;
  menu?: ReactNode;
  onTitle?: () => void;
  logoUrl?: string | null;
  orgName?: string;
}) {
  return (
    <header className="scan-capsule" data-testid="scan-capsule">
      {logoUrl ? <ScanOrgLogo className="scan-capsule-logo" src={logoUrl} name={orgName} /> : null}
      <button type="button" className="scan-capsule-title" onClick={onTitle}>
        <span className="scan-capsule-name">
          {name}
          {staff ? <span> · {staff}</span> : null}
        </span>
        <span className="scan-capsule-state" data-state={state}>
          <span className="scan-dot" />
          {mode ? `${mode} · ` : ''}
          {STATE_TEXT[state]}
          {direction ? ` · ${direction}` : ''}
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
