import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { WalletCards } from 'lucide-react';
import type { ReactNode } from 'react';
import { PassCard } from '../pass-card/index.tsx';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  StatusPill,
} from '../ui/index.ts';
import { myPassesQuery } from './api.ts';
import { formatWhen, type MyPass, passName, toView } from './pass-view.ts';
import { RefreshButton } from './refresh-button.tsx';
import { AddToWalletButton, publicUrlOf, QrButton, RemovePassButton } from './wallet-actions.tsx';

const isApplePhone = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function PassTile({ pass }: { pass: MyPass }) {
  const name = passName(pass);
  const publicUrl = publicUrlOf(pass.downloadUrl);
  const voided = pass.status === 'voided';
  return (
    <Card className="flex flex-col gap-3 p-4">
      <PassCard view={toView(pass)} face="front" />
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-sm font-semibold text-fg-strong">
            <Link
              to="/passes/$passId"
              params={{ passId: pass.id }}
              className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {name}
            </Link>
          </h2>
          {voided ? <StatusPill status="voided" /> : null}
        </div>
        <p className="truncate text-xs text-fg-muted">{pass.orgName}</p>
        <p className="text-xs text-fg-subtle">Updated {formatWhen(pass.modifiedAt)}</p>
      </div>
      {voided ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <AddToWalletButton downloadUrl={pass.downloadUrl} size="sm" />
          <RefreshButton passId={pass.id} pass={pass} size="sm" />
          {publicUrl && !isApplePhone() ? <QrButton passTitle={name} url={publicUrl} /> : null}
        </div>
      )}
      <div className="flex justify-end">
        <RemovePassButton passId={pass.id} passTitle={name} />
      </div>
    </Card>
  );
}

export function MyPassesPage() {
  const query = useInfiniteQuery(myPassesQuery);
  const passes = query.data?.pages.flatMap((p) => p.items) ?? [];

  let body: ReactNode;
  if (query.isPending) {
    body = (
      <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    );
  } else if (query.isError) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else if (passes.length === 0) {
    body = (
      <EmptyState
        icon={WalletCards}
        title="No passes yet"
        description="Passes sent to your sign-in email appear here."
      />
    );
  } else {
    body = (
      <>
        <ul className="grid gap-4 sm:grid-cols-2">
          {passes.map((pass) => (
            <li key={pass.id}>
              <PassTile pass={pass} />
            </li>
          ))}
        </ul>
        {query.hasNextPage ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <PageHeader title="My passes" />
      {body}
    </>
  );
}
