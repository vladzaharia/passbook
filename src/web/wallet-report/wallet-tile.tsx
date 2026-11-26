import type { ReportStatus } from '@/passkit/wallets/types.ts';
import { walletName } from '@/shared/copy/previews.ts';
import { cn } from '../lib/cn.ts';
import { WalletStatus } from './wallet-status.tsx';
import './wallet-report.css';

export type TileTarget = 'apple' | 'google' | 'samsung';

/** The pass in the wallet's own shape, in the pass's colour: a logo dot and a code block. */
export function MiniCard({ target, color }: { target: TileTarget; color?: string | undefined }) {
  return (
    <span
      aria-hidden
      data-target={target}
      className="wt-card"
      style={color ? ({ '--wt-fill': color } as React.CSSProperties) : undefined}
    >
      <span className="wt-dot" />
      <span className="wt-code" />
    </span>
  );
}

export interface WalletTileProps {
  target: TileTarget;
  /** The pass's backgroundColor. */
  color?: string | undefined;
  /** `Loyalty · Automatic`, or the style label for the Apple source. */
  meta: string;
  status?: ReportStatus | undefined;
  /** Hatched: off for this template, still open. */
  off?: boolean | undefined;
  /** A pill-less tile (Apple, the source). */
  source?: boolean | undefined;
  className?: string | undefined;
}

/** The wallet tile's face: used by the designer's rail (as a radio) and the import report. */
export function WalletTileBody({ target, color, meta, status, off, source }: WalletTileProps) {
  return (
    <>
      <MiniCard target={target} color={color} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="text-sm font-medium text-fg-strong [overflow-wrap:anywhere]">
          {target === 'apple' ? 'Apple Wallet' : walletName(target)}
        </span>
        <span className="truncate text-xs text-fg-muted">
          {off ? 'Off for this template.' : meta}
        </span>
      </span>
      {status ? <WalletStatus status={status} className="wt-pill" /> : null}
      {source ? <span className="wt-source text-xs text-fg-muted">Source</span> : null}
    </>
  );
}

/** A static tile (no radio): the import report's two wallets. */
export function WalletTile(props: WalletTileProps) {
  return (
    <div
      className={cn('wt wt-static', props.off && 'wl-hatch', props.className)}
      data-testid={`${props.target}-tile`}
    >
      <WalletTileBody {...props} />
    </div>
  );
}
