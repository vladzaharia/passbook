import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ChainLevel } from '@/shared/contracts/channels.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { scanLine } from '@/shared/copy/scan.ts';

/**
 * A channel a level stops: the card greyed under the reason, the level that stops it and, where the
 * viewer can act, the way to the level. Every preview switcher draws this one pane.
 */
export function LockedPreview({
  title,
  level,
  card,
  children,
}: {
  /** "Google Wallet: Off for this template". */
  title: string;
  level: ChainLevel;
  /** The card, drawn greyed behind the veil. */
  card: ReactNode;
  /** The action for this level: a link to it, or Ask PassBook. */
  children?: ReactNode;
}) {
  return (
    <div
      data-locked={level}
      className="relative mx-auto flex w-full max-w-60 flex-col items-center"
    >
      <div aria-hidden inert className="pointer-events-none w-full opacity-40 grayscale">
        {card}
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-surface-raised/85 p-4 text-center backdrop-blur-sm">
        <Lock aria-hidden className="size-5 text-fg-muted" />
        <p className="text-sm font-medium text-fg-strong">{title}</p>
        <p className="text-xs text-fg-muted">
          {scanLine(PASS_SETUP_COPY.page.lockedBy, { level: PASS_SETUP_COPY.levels[level] })}
        </p>
        {children}
      </div>
    </div>
  );
}
