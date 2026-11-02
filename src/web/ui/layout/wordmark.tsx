import { Link } from '@tanstack/react-router';
import { WalletCards } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn.ts';

const KEY = 'wallet-wordmark-flipped';

/**
 * True until a wordmark has flipped in this browser session. Read once per page load; the flag
 * is written only when a flip plays, so /login (no flip) does not use it up.
 */
function unflippedThisSession(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    if (sessionStorage.getItem(KEY)) return false;
    // Prove the later write works, so a read-only store cannot flip on every load.
    sessionStorage.setItem(`${KEY}-probe`, '1');
    sessionStorage.removeItem(`${KEY}-probe`);
    return true;
  } catch {
    // Storage blocked: never flip, rather than flip on every load.
    return false;
  }
}

function markFlipped() {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    // Writable at load (the probe); at worst the next load flips once more.
  }
}

const flipThisLoad = unflippedThisSession();
let shown = false;

const SIZES = {
  md: { link: 'gap-2 text-base', icon: 'size-5' },
  // The hosted header: 20 px on the type scale, the mark at 1.2× the text.
  lg: { link: 'gap-2.5 text-xl tracking-[-0.015em]', icon: 'size-6' },
} as const;

/**
 * The wordmark card flips once per browser session; never on the sign-in scene (flip={false}).
 * `markOnly` drops the word: views that show the Add to Apple Wallet badge never show a bare
 * "PassBook" brand beside it. `lg` is the hosted sign-in header.
 */
export function Wordmark({
  to = '/',
  flip = true,
  markOnly = false,
  size = 'md',
}: {
  to?: string;
  flip?: boolean;
  markOnly?: boolean;
  size?: keyof typeof SIZES;
}) {
  // Latched per instance, so a re-render mid-flip does not cut it short.
  const [play] = useState(() => flip && flipThisLoad && !shown);
  useEffect(() => {
    if (!play) return;
    shown = true;
    markFlipped();
  }, [play]);
  return (
    <Link
      to={to}
      className={cn(
        'inline-flex min-h-8 min-w-8 items-center justify-center rounded-md font-semibold text-fg-strong pointer-coarse:min-h-11 pointer-coarse:min-w-11',
        SIZES[size].link,
      )}
    >
      <WalletCards
        aria-hidden
        data-flip={play || undefined}
        className={cn('wl-wordmark-icon text-accent-fg', SIZES[size].icon)}
      />
      {markOnly ? <span className="sr-only">Home</span> : 'PassBook'}
    </Link>
  );
}
