import type { WalletProvider } from '@/shared/contracts/wallet-providers.ts';
import { Card, CardBody, CardHeader, ErrorState, SkeletonRows } from '@/web/ui/index.ts';
import { useWalletRelease } from './queries.ts';
import { RELEASE_COPY } from './release-copy.ts';
import { ReleaseMode } from './release-mode.tsx';

/**
 * Where a provider stands on release, per mode, and the enable-ready dry run. The card reads the
 * state and never changes it: turning a wallet on is a code change (the flip PR).
 */
export function ReleaseCard({ provider }: { provider: WalletProvider }) {
  const report = useWalletRelease();
  const modes = report.data?.releases.filter((r) => r.provider === provider) ?? [];
  return (
    <Card>
      <CardHeader title={RELEASE_COPY.title} />
      <CardBody className="grid gap-4 lg:grid-cols-2">
        {report.isPending ? (
          <SkeletonRows rows={3} label="Loading release" />
        ) : report.isError ? (
          <ErrorState subject="release" error={report.error} onRetry={() => report.refetch()} />
        ) : (
          modes
            .sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'live' ? -1 : 1))
            .map((r) => <ReleaseMode key={r.mode} release={r} />)
        )}
      </CardBody>
    </Card>
  );
}
