import { Link } from '@tanstack/react-router';
import { WalletCards } from 'lucide-react';

export function Wordmark({ to = '/' }: { to?: string }) {
  return (
    <Link
      to={to as never}
      className="inline-flex min-h-8 items-center gap-2 rounded-md text-base font-semibold text-fg-strong"
    >
      <WalletCards aria-hidden className="wl-wordmark-icon size-5 text-accent-fg" />
      Wallet
    </Link>
  );
}
