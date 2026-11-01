import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Wallet, WalletCards } from 'lucide-react';
import type { ReactNode } from 'react';
import { MY_PASSES_BUNDLE_PATH, MY_PASSES_BUNDLE_SIZE } from '../../shared/contracts/me.ts';
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
import { AddToWalletButton, PassMoreMenu, publicUrlOf } from './wallet-actions.tsx';

const isApplePhone = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function PassTile({ pass }: { pass: MyPass }) {
  const name = passName(pass);
  const publicUrl = publicUrlOf(pass.downloadUrl);
  const voided = pass.status === 'voided';
  return (
    <Card className="flex w-full flex-col gap-3 p-4">
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
      <div className="mt-auto flex items-center gap-2">
        {voided ? null : (
          <>
            <AddToWalletButton downloadUrl={pass.downloadUrl} size="sm" />
            <RefreshButton passId={pass.id} pass={pass} size="sm" />
          </>
        )}
        <PassMoreMenu
          passId={pass.id}
          passTitle={name}
          qrUrl={voided || isApplePhone() ? null : publicUrl}
        />
      </div>
    </Card>
  );
}

/** One link per bundle of 10 active passes; Apple Wallet takes a .pkpasses file as one add. */
function AddAllLinks({ count }: { count: number }) {
  if (count < 2) return null;
  const parts = Math.ceil(count / MY_PASSES_BUNDLE_SIZE);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {Array.from({ length: parts }, (_, i) => {
        const from = i * MY_PASSES_BUNDLE_SIZE + 1;
        const to = Math.min(count, from + MY_PASSES_BUNDLE_SIZE - 1);
        return (
          <Button key={from} asChild variant="outline" size="sm" iconStart={<Wallet aria-hidden />}>
            <a href={`${MY_PASSES_BUNDLE_PATH}?part=${i + 1}`}>
              {parts === 1
                ? 'Add all to Apple Wallet'
                : `Add pass${from === to ? ` ${from}` : `es ${from}-${to}`} to Apple Wallet`}
            </a>
          </Button>
        );
      })}
    </div>
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
        title="No passes"
        description="Passes sent to your sign-in email appear here."
      />
    );
  } else {
    body = (
      <>
        <AddAllLinks count={passes.filter((p) => p.status !== 'voided').length} />
        <ul className="grid gap-4 sm:grid-cols-2">
          {passes.map((pass) => (
            <li key={pass.id} className="flex">
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
