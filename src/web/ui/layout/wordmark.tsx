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
 * `lg` is the hosted sign-in header.
 */
export function Wordmark({
  to = '/',
  hello = true,
  size = 'md',
  reload = false,
  sub,
}: {
  to?: string;
  hello?: boolean;
  size?: keyof typeof SIZES;
  /** A plain link: the space is another document (the developer site, rendered at build time). */
  reload?: boolean;
  /** Names a space that is not the console, after a hairline. Hidden on phones. */
  sub?: string;
}) {
  // Latched per instance, so a re-render mid-hello does not cut it short.
  const [play] = useState(() => hello && helloThisLoad && !shown);
  useEffect(() => {
    if (!play) return;
    shown = true;
    markSeen();
  }, [play]);
  const className = cn(
    'inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-md font-semibold text-fg-strong pointer-coarse:min-h-11 pointer-coarse:min-w-11',
    SIZES[size].link,
  );
  const body = (
    <>
      <BrandMark hello={play} className={cn('text-accent-fg', SIZES[size].icon)} />
      PassBook
      {sub ? (
        <span className="border-l border-border pl-2 font-medium text-fg-muted max-sm:hidden">
          {sub}
        </span>
      ) : null}
    </>
  );
  return reload ? (
    <a href={to} className={className}>
      {body}
    </a>
  ) : (
    <Link to={to} className={className}>
      {body}
    </Link>
  );
}
