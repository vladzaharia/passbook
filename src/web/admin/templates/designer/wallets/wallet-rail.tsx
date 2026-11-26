import { ArrowRight } from 'lucide-react';
import { type KeyboardEvent, useRef } from 'react';
import type { WalletTarget } from '@/passkit/wallets/types.ts';
import { typeLabel, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { cn } from '../../../../lib/cn.ts';
import { useChangeCount } from '../../../../lib/motion.ts';
import { ActiveIndicator } from '../../../../ui/active-indicator.tsx';
import { MiniCard, WalletTileBody } from '../../../../wallet-report/wallet-tile.tsx';
import { STYLE_LABEL } from '../model.ts';
import type { WalletName } from './roles-model.ts';
import { targetBlock, type WalletEnv } from './wallets-env.ts';
import './wallets.css';

const C = WALLETS_COPY;

export interface RailWallet {
  target: WalletName;
  env: Pick<WalletEnv, 'out' | 'block'>;
  off: boolean;
}

/** One pass, three wallets: the Apple source, an arrow, then a tile per wallet (a radiogroup). */
export function WalletRail({
  wallets,
  value,
  onChange,
  color,
  styleName,
  onApple,
}: {
  wallets: readonly RailWallet[];
  value: WalletName | undefined;
  onChange: (target: WalletName) => void;
  color: string | undefined;
  styleName: keyof typeof STYLE_LABEL;
  onApple: () => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  // The arrow plays one dot along its line when a status or an item count changes, never per keystroke.
  const signal = useChangeCount(
    wallets.map((w) => `${w.env.out.report.status.kind}${w.env.out.report.items.length}`).join('|'),
  );
  const move = (e: KeyboardEvent) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
    if (!keys.includes(e.key) || wallets.length < 2) return;
    e.preventDefault();
    const at = wallets.findIndex((w) => w.target === value);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = wallets[(at + step + wallets.length) % wallets.length];
    if (!next) return;
    onChange(next.target);
    group.current?.querySelector<HTMLElement>(`[data-value="${next.target}"]`)?.focus();
  };
  return (
    <div className="wt-rail">
      <button type="button" className="wt wt-apple" onClick={onApple}>
        <MiniCard target="apple" color={color} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
          <span className="truncate text-sm font-medium text-fg-strong">Apple Wallet</span>
          <span className="truncate text-xs text-fg-muted">{STYLE_LABEL[styleName]}</span>
        </span>
        <span className="wt-source text-xs text-fg-muted">{C.source}</span>
      </button>
      <span key={signal} className="wt-arrow" data-play={signal > 0 || undefined} aria-hidden>
        <ArrowRight className="size-4" />
        <span className="wt-dot-run" />
      </span>
      <div ref={group} role="radiogroup" aria-label={C.rail} className="wt-tiles" onKeyDown={move}>
        {wallets.map((w, i) => {
          const { out, block } = w.env;
          const set = targetBlock(block, w.target);
          const type = typeLabel(w.target, out.compiled.type || String(set.type ?? ''));
          const meta = `${type} · ${typeof set.type === 'string' && set.type !== 'off' ? C.setHere : C.automatic}`;
          const checked = value === w.target;
          const name = w.target === 'google' ? 'Google Wallet' : 'Samsung Wallet';
          return (
            // biome-ignore lint/a11y/useSemanticElements: radio tile
            <button
              key={w.target}
              type="button"
              role="radio"
              data-value={w.target}
              aria-checked={checked}
              aria-label={`${name}, ${type}, ${
                out.report.status.kind === 'omissions'
                  ? `Ready with omissions (${out.report.status.count})`
                  : out.report.status.kind === 'blocked'
                    ? 'Blocked'
                    : out.report.status.kind === 'off'
                      ? 'Off'
                      : 'Ready'
              }`}
              tabIndex={checked ? 0 : -1}
              style={{ '--i': i } as React.CSSProperties}
              className={cn('wt wt-pick', w.off && 'wl-hatch')}
              onClick={() => onChange(w.target)}
            >
              <WalletTileBody
                target={w.target as Exclude<WalletTarget, never>}
                color={color}
                meta={meta}
                status={out.report.status}
                off={w.off}
              />
            </button>
          );
        })}
        <ActiveIndicator variant="pill" />
      </div>
    </div>
  );
}
