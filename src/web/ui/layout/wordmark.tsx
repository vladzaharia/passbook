import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import { BrandMark } from './brand-mark.tsx';

const KEY = 'wallet-wordmark-hello';

/**
 * True until a wordmark has said hello in this browser session. Read once per page load; the flag
 * is written only when a hello plays, so /login (no hello) does not use it up.
 */
function unseenThisSession(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    if (sessionStorage.getItem(KEY)) return false;
    // Prove the later write works, so a read-only store cannot say hello on every load.
    sessionStorage.setItem(`${KEY}-probe`, '1');
    sessionStorage.removeItem(`${KEY}-probe`);
    return true;
  } catch {
    // Storage blocked: never say hello, rather than on every load.
    return false;
  }
}

function markSeen() {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    // Writable at load (the probe); at worst the next load says hello once more.
  }
}

const helloThisLoad = unseenThisSession();
let shown = false;

const SIZES = {
  md: { link: 'gap-2 text-base', icon: 'size-5' },
  // The hosted header: 20 px on the type scale, the mark at 1.2× the text.
  lg: { link: 'gap-2.5 text-xl tracking-[-0.015em]', icon: 'size-6' },
} as const;

/**
 * The mark says hello once per browser session; never on the sign-in scene (hello={false}).
 * `markOnly` drops the word: views that show the Add to Apple Wallet badge never show a bare
 * "PassBook" brand beside it. `lg` is the hosted sign-in header.
 */
export function Wordmark({
  to = '/',
  hello = true,
  markOnly = false,
  size = 'md',
}: {
  to?: string;
  hello?: boolean;
  markOnly?: boolean;
  size?: keyof typeof SIZES;
}) {
  // Latched per instance, so a re-render mid-hello does not cut it short.
  const [play] = useState(() => hello && helloThisLoad && !shown);
  useEffect(() => {
    if (!play) return;
    shown = true;
    markSeen();
  }, [play]);
  return (
    <Link
      to={to}
      className={cn(
        'inline-flex min-h-8 min-w-8 items-center justify-center rounded-md font-semibold text-fg-strong pointer-coarse:min-h-11 pointer-coarse:min-w-11',
        SIZES[size].link,
      )}
    >
      <BrandMark hello={play} className={cn('text-accent-fg', SIZES[size].icon)} />
      {markOnly ? <span className="sr-only">Home</span> : 'PassBook'}
    </Link>
  );
}
