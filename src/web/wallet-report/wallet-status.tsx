import { statusLabel } from '@/passkit/wallets/fidelity.ts';
import type { ReportStatus } from '@/passkit/wallets/types.ts';
import type { WALLET_FIDELITY_STATUS } from '../lib/status.ts';
import { StatusPill } from '../ui/status-pill-base.tsx';

type Key = keyof typeof WALLET_FIDELITY_STATUS;

const KEY: Record<ReportStatus['kind'], Key> = {
  ready: 'wallet_ready',
  omissions: 'wallet_omissions',
  blocked: 'wallet_blocked',
  off: 'wallet_off',
};

/** The one pill for a wallet's report: Ready, Ready with omissions (n), Blocked, Off. */
export function WalletStatus({
  status,
  className,
}: {
  status: ReportStatus;
  className?: string | undefined;
}) {
  const label = status.kind === 'blocked' ? 'Blocked' : statusLabel(status);
  return (
    <span
      title={status.kind === 'blocked' ? statusLabel(status) : undefined}
      className="inline-flex"
    >
      <StatusPill status={KEY[status.kind]} className={className}>
        {label}
      </StatusPill>
    </span>
  );
}
