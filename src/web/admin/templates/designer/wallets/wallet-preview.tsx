import { type ReactNode, useState } from 'react';
import { walletName } from '@/shared/copy/previews.ts';
import { WALLETS_COPY } from '@/shared/copy/wallets.ts';
import type { WalletPreviews } from '../../../../channel-previews/use-wallet-previews.ts';
import { WalletChannel } from '../../../../channel-previews/wallet-channel.tsx';
import { Badge, LoadingRail } from '../../../../ui/index.ts';
import type { WalletName } from './roles-model.ts';
import { usePartDrop } from './use-part-drop.ts';

/**
 * The real compiled card of the focused wallet, sized to the face shown. While Blocked it is a
 * hatched outline: a blocked wallet shows its report and no card. Apple compares in place.
 */
export function WalletPreview({
  target,
  previews,
  checking,
  blocked,
  off,
  apple,
}: {
  target: WalletName;
  previews: WalletPreviews;
  checking: boolean;
  blocked: boolean;
  /** `type: 'off'` in the package: no card at all. */
  off: boolean;
  apple: ReactNode;
}) {
  const [compare, setCompare] = useState(false);
  const type = previews.state === 'ready' ? previews.out[target].compiled.type : '';
  const body = previews.state === 'ready' ? JSON.stringify(previews.out[target].compiled) : '';
  const host = usePartDrop(body, `${target}:${type}`);
  return (
    <div className="wm-card-frame grid gap-3" data-testid="wallet-preview">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg-strong">
          {walletName(target)}
          <Badge title="An approximation of how the wallet draws it.">
            {WALLETS_COPY.preview.approximate}
          </Badge>
        </h3>
        <button
          type="button"
          aria-pressed={compare}
          aria-label={WALLETS_COPY.preview.compareLabel}
          className="rounded-md border border-border-strong px-2 text-xs text-fg-muted wl-colors hover:text-fg aria-pressed:border-accent aria-pressed:bg-accent-subtle aria-pressed:text-accent-fg min-h-8 pointer-coarse:min-h-11"
          onPointerDown={() => setCompare(true)}
          onPointerUp={() => setCompare(false)}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              setCompare((v) => !v);
            }
          }}
          onClick={() => undefined}
        >
          {WALLETS_COPY.preview.compare}
        </button>
      </div>
      <div ref={host} className="relative" aria-busy={checking || undefined}>
        <LoadingRail show={checking} />
        {compare ? (
          <div className="wm-fade">{apple}</div>
        ) : blocked ? (
          <div className="wm-blocked-card hatch wl-hatch">{WALLETS_COPY.report.noPreview}</div>
        ) : off ? null : (
          <div key={`${target}:${type}`} className="wm-deal wm-fade">
            <WalletChannel target={target} previews={previews} notes={false} fit />
          </div>
        )}
      </div>
    </div>
  );
}
