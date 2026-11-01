import { Link } from '@tanstack/react-router';
import { WalletCards } from 'lucide-react';
import { useEffect } from 'react';

const KEY = 'wallet-wordmark-flipped';

/** True on the first load of this browser session. Read once per page load. */
function firstThisSession(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    if (sessionStorage.getItem(KEY)) return false;
    sessionStorage.setItem(KEY, '1');
    return true;
  } catch {
    // Storage blocked: never flip, rather than flip on every load.
    return false;
  }
}

const flipThisLoad = firstThisSession();
let shown = false;

/** The wordmark card flips once per browser session; never on the sign-in scene (flip={false}). */
export function Wordmark({ to = '/', flip = true }: { to?: string; flip?: boolean }) {
  const play = flip && flipThisLoad && !shown;
  useEffect(() => {
    if (play) shown = true;
  }, [play]);
  return (
    <Link
      to={to}
      className="inline-flex min-h-8 items-center gap-2 rounded-md text-base font-semibold text-fg-strong pointer-coarse:min-h-11"
    >
      <WalletCards
        aria-hidden
        data-flip={play || undefined}
        className="wl-wordmark-icon size-5 text-accent-fg"
      />
      Wallet
    </Link>
  );
}
