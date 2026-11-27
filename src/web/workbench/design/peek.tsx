import { useEffect, useRef, useState } from 'react';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import type { PreviewSource } from '../../channel-previews/types.ts';
import { useWalletPreviews } from '../../channel-previews/use-wallet-previews.ts';
import type { WalletTargetOut } from '../../channel-previews/wallet-kit.ts';
import { Buddy } from '../../ui/art/buddy.tsx';

const PEEK_MS = 2600;

/** Every note the wallets make for the pass on screen, by wallet, path and what it says. */
export function noteKeys(out: Pick<WalletTargetOut, 'google' | 'samsung'>): string[] {
  return (['google', 'samsung'] as const).flatMap((wallet) =>
    out[wallet].report.items.map((i) => `${wallet}:${i.path}:${i.message}`),
  );
}

/**
 * The buddy peeks over the stage's corner when a wallet drops something new (design D7): once per
 * note, never for the notes already there when the page opened.
 */
export function WalletPeek({ source }: { source: PreviewSource | null }) {
  const previews = useWalletPreviews(source);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState(0);
  useEffect(() => {
    if (previews.state !== 'ready') return;
    const keys = noteKeys(previews.out);
    if (seen.current === null) {
      seen.current = new Set(keys);
      return;
    }
    const known = seen.current;
    const added = keys.filter((k) => !known.has(k));
    for (const k of keys) known.add(k);
    if (added.length === 0) return;
    setFresh(added.length);
    const t = setTimeout(() => setFresh(0), PEEK_MS);
    return () => clearTimeout(t);
  }, [previews]);
  if (fresh === 0) return null;
  return (
    <div data-testid="wallet-peek" role="status">
      <span className="sr-only">{WB_DESIGN.peek(fresh)}</span>
      <Buddy size="sm" at="end" mood="curious" scene="peek" />
    </div>
  );
}
