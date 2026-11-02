import { Link } from '@tanstack/react-router';
import { WalletCards } from 'lucide-react';
import { useEffect, useState } from 'react';

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

/**
 * The wordmark card flips once per browser session; never on the sign-in scene (flip={false}).
 * `markOnly` drops the word: views that show the Add to Apple Wallet badge never show a bare
 * "Wallet" brand beside it.
 */
export function Wordmark({
  to = '/',
  flip = true,
  markOnly = false,
}: {
  to?: string;
  flip?: boolean;
  markOnly?: boolean;
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
      className="inline-flex min-h-8 min-w-8 items-center justify-center gap-2 rounded-md text-base font-semibold text-fg-strong pointer-coarse:min-h-11 pointer-coarse:min-w-11"
    >
      <WalletCards
        aria-hidden
        data-flip={play || undefined}
        className="wl-wordmark-icon size-5 text-accent-fg"
      />
      {markOnly ? <span className="sr-only">Home</span> : 'Wallet'}
    </Link>
  );
}
