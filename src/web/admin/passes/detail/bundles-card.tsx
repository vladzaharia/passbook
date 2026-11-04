import { useState } from 'react';
import type { BundleDto } from '@/shared/contracts/bundles.ts';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  ListRow,
  ListRows,
  Skeleton,
  toast,
} from '../../../ui/index.ts';
import { useBundleActions, useBundlesOfPass } from '../bundle-api.ts';
import { absoluteUrl } from '../format.ts';

function BundleRow({ bundle }: { bundle: BundleDto }) {
  const actions = useBundleActions(bundle.id);
  const [ask, setAsk] = useState<'rotate' | 'delete' | null>(null);
  const n = bundle.passes.length;
  return (
    <>
      <ListRow
        leading={<ACTION_ICON.bundle aria-hidden />}
        title={bundle.name}
        meta={`${n} ${n === 1 ? 'pass' : 'passes'}${bundle.holderEmail ? ` · ${bundle.holderEmail}` : ''}`}
        trailing={
          <span className="flex items-center gap-1">
            <CopyButton value={absoluteUrl(bundle.url)} label="Copy link" />
            <Button
              size="sm"
              variant="ghost"
              iconStart={<ACTION_ICON.rotate aria-hidden />}
              onClick={() => setAsk('rotate')}
            >
              Rotate
            </Button>
            <Button
              size="sm"
              variant="ghost"
              iconStart={<ACTION_ICON.delete aria-hidden />}
              onClick={() => setAsk('delete')}
            >
              Delete
            </Button>
          </span>
        }
      />
      <ConfirmDialog
        open={ask === 'rotate'}
        onOpenChange={(o) => !o && setAsk(null)}
        title="Rotate the link?"
        description="The old link stops working. The new one is not sent."
        confirmLabel="Rotate"
        onConfirm={async () => {
          await actions.rotate.mutateAsync();
          toast.success('Link rotated');
        }}
      />
      <ConfirmDialog
        open={ask === 'delete'}
        onOpenChange={(o) => !o && setAsk(null)}
        title={`Delete ${bundle.name}?`}
        description="The link stops working. The passes stay."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await actions.remove.mutateAsync();
          toast.success('Bundle deleted');
        }}
      />
    </>
  );
}

/** The bundles this pass is in (the current mode), with the link's Copy, Rotate and Delete. */
export function BundlesCard({ passId }: { passId: string }) {
  const bundles = useBundlesOfPass(passId);
  const items = bundles.data?.items ?? [];
  return (
    <Card className="min-w-0">
      <CardHeader title="In bundles" />
      {bundles.isError ? (
        <CardBody>
          <ErrorState inline error={bundles.error} onRetry={() => void bundles.refetch()} />
        </CardBody>
      ) : bundles.isPending ? (
        <CardBody>
          <Skeleton className="h-10 w-full" />
        </CardBody>
      ) : items.length === 0 ? (
        <EmptyState inline art="passes" title="Not in a bundle" />
      ) : (
        <CardBody>
          <ListRows label="Bundles">
            {items.map((b) => (
              <BundleRow key={b.id} bundle={b} />
            ))}
          </ListRows>
        </CardBody>
      )}
    </Card>
  );
}
