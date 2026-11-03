import { Check, QrCode, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import { ADD_COPY } from '../../../shared/copy/add.ts';

/**
 * The kit's outline button (md: 36, 44 on touch) as plain classes: this file renders on /p too,
 * where the kit Button's browser-only imports cannot go.
 */
const REVEAL =
  'relative inline-flex min-h-9 shrink-0 cursor-pointer select-none items-center justify-center gap-2 rounded-md border border-border-strong px-4 py-1.5 text-sm font-medium text-fg transition-[color,background-color] duration-(--wl-dur-hover) hover:bg-state-hover-tint hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:min-h-11 [&_svg]:size-4';

/** Show QR (or Add to this iPhone): opens the add block again for another device. */
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
      className={REVEAL}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <Icon aria-hidden />
      {open
        ? phone
          ? ADD_COPY.hide
          : ADD_COPY.hideQr
        : phone
          ? ADD_COPY.addHere
          : ADD_COPY.showQr}
    </button>
  );
}

/**
 * In Apple Wallet already: a calm line, no badge pushed. `children` is the reveal button. The
 * check leads it, unless the buddy stands over the words (c).
 */
export function AddedLine({ children, mark = true }: { children?: ReactNode; mark?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
      {mark ? (
        <span aria-hidden className="wl-added-mark">
          <Check />
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-fg-strong">{ADD_COPY.added}</p>
        <p className="text-sm text-fg-muted">{ADD_COPY.addedLine}</p>
      </div>
      {children}
    </div>
  );
}
