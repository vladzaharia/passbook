import { QrCode, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import { HOLDER_COPY } from '../../../shared/copy/holder.ts';

/**
 * The kit's outline button (md: 36, 44 on touch) as plain classes: this file renders on /p too,
 * where the kit Button's browser-only imports cannot go.
 */
export const OUTLINE_ACTION_CLASS =
  'relative inline-flex min-h-9 shrink-0 cursor-pointer select-none items-center justify-center gap-2 rounded-md border border-border-strong px-4 py-1.5 text-sm font-medium text-fg transition-[color,background-color] duration-(--wl-dur-hover) hover:bg-state-hover-tint hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:min-h-11 [&_svg]:size-4';

/** Show QR (Add to this iPhone): adding again, for another device. */
export function RevealButton({
  open,
  onToggle,
  phone,
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  /** On the iPhone the badge comes back, not the QR. */
  phone: boolean;
  controls: string;
}) {
  const Icon = phone ? Smartphone : QrCode;
  return (
    <button
      type="button"
      className={OUTLINE_ACTION_CLASS}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <Icon aria-hidden />
      {open
        ? phone
          ? HOLDER_COPY.hide
          : HOLDER_COPY.hideQr
        : phone
          ? HOLDER_COPY.addHere
          : HOLDER_COPY.showQr}
    </button>
  );
}

/** An Apple registration was reported: a calm line and a reveal button. */
export function AddedLine({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-fg-strong">{HOLDER_COPY.added}</p>
        <p className="text-sm text-fg-muted">{HOLDER_COPY.addedLine}</p>
      </div>
      {children}
    </div>
  );
}
