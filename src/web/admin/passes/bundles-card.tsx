import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { BundleDto } from '@/shared/contracts/bundles.ts';
import type { Mode } from '@/shared/contracts/common.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { ENTITY } from '../../lib/entities.ts';
import { sessionQuery } from '../../lib/session.ts';
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
  RowActions,
  Skeleton,
  toast,
} from '../../ui/index.ts';
import { ModePill } from '../../ui/layout/mode-pill.tsx';
import { useBundleActions, useBundlesOfPass } from './bundle-api.ts';
import { RelTime, useNow } from './detail/rel-time.tsx';
import { reportEmailError } from './email-outcome.ts';
import { absoluteUrl } from './format.ts';
import { RotateLink } from './rotated-link-dialog.tsx';

const SHOWN = 5;

function BundleRow({
  bundle,
  now,
  readOnly,
}: {
  bundle: BundleDto;
  now: number;
  readOnly: boolean;
}) {
  const actions = useBundleActions(bundle.id, bundle.mode);
  const client = useQueryClient();
  const [ask, setAsk] = useState<'rotate' | 'delete' | null>(null);
  const n = bundle.passes.length;
  return (
    <>
      <ListRow
        leading={<ACTION_ICON.bundle aria-hidden />}
        title={bundle.name}
        pills={<ModePill mode={bundle.mode} compact />}
        meta={
          <>
            <span className="block">
              {n} {n === 1 ? 'pass' : 'passes'}
              {bundle.holderEmail ? ` · ${bundle.holderEmail}` : ''}
            </span>
            <span className="block">
              Created <RelTime at={bundle.createdAt} now={now} />
              {bundle.linkRotatedAt ? (
                <>
                  {' · Link rotated '}
                  <RelTime at={bundle.linkRotatedAt} now={now} />
                </>
              ) : null}
            </span>
          </>
        }
        trailing={
          <span className="flex items-center gap-1">
            <CopyButton value={absoluteUrl(bundle.url)} label="Copy link" />
            <RowActions
              label={`Actions for ${bundle.name}`}
              actions={[
                {
                  label: 'Rotate link',
                  icon: ACTION_ICON.rotate,
                  disabled: readOnly,
                  onSelect: () => setAsk('rotate'),
                },
                ...(bundle.holderEmail
                  ? [
                      {
                        label: 'Send email',
                        icon: ACTION_ICON.sendEmail,
                        loading: actions.sendEmail.isPending,
                        disabled: readOnly,
                        onSelect: () => {
                          const before = client.getQueryData<SessionResponse>(
                            sessionQuery.queryKey,
                          );
                          if (!before?.authenticated) return;
                          const userId = before.user.id;
                          actions.sendEmail.mutate(undefined, {
                            onSuccess: () => {
                              const current = client.getQueryData<SessionResponse>(
                                sessionQuery.queryKey,
                              );
                              if (!current?.authenticated || current.user.id !== userId) return;
                              toast.info(
                                bundle.mode === 'test'
                                  ? 'Test email queued. Check the Test inbox for capture.'
                                  : 'Email queued',
                              );
                            },
                            onError: (error) => {
                              const current = client.getQueryData<SessionResponse>(
                                sessionQuery.queryKey,
                              );
                              if (!current?.authenticated || current.user.id !== userId) return;
                              reportEmailError(error);
                            },
                          });
                        },
                      },
                    ]
                  : []),
                {
                  label: 'Delete',
                  icon: ACTION_ICON.delete,
                  destructive: true,
                  disabled: readOnly,
                  onSelect: () => setAsk('delete'),
                },
              ]}
            />
          </span>
        }
      />
      <RotateLink
        open={!readOnly && ask === 'rotate'}
        onOpenChange={(o) => !o && setAsk(null)}
        description="The current link stops working. The passes stay."
        rotate={async () => (await actions.rotate.mutateAsync()).url}
        holderEmail={bundle.holderEmail}
        mode={bundle.mode}
        sendEmail={() => actions.sendEmail.mutateAsync()}
      />
      <ConfirmDialog
        open={!readOnly && ask === 'delete'}
        onOpenChange={(o) => !o && setAsk(null)}
        title={`Delete ${bundle.name}?`}
        description="The link stops working. The passes stay."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (readOnly) return;
          const before = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
          if (!before?.authenticated) return;
          const userId = before.user.id;
          await actions.remove.mutateAsync();
          const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
          if (!current?.authenticated || current.user.id !== userId) return;
          toast.success('Bundle deleted');
        }}
      />
    </>
  );
}

/** The bundles this pass is in (in its own mode), with the link's Copy, Rotate and Delete. */
export function BundlesCard({
  passId,
  orgId,
  mode,
  readOnly,
}: {
  passId: string;
  orgId: string;
  mode: Mode;
  /** Bundles remain visible but cannot be changed. */
  readOnly: boolean;
}) {
  const bundles = useBundlesOfPass(passId, orgId, mode);
  const now = useNow();
  const [all, setAll] = useState(false);
  const items = useMemo(
    () => [...(bundles.data?.items ?? [])].sort((a, b) => b.createdAt - a.createdAt),
    [bundles.data],
  );
  const shown = all ? items : items.slice(0, SHOWN);
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
        <EmptyState inline art={ENTITY.bundle.art} title="Not in a bundle" />
      ) : (
        <CardBody>
          <ListRows label="Bundles">
            {shown.map((b) => (
              <BundleRow key={b.id} bundle={b} now={now} readOnly={readOnly} />
            ))}
          </ListRows>
          {items.length > SHOWN ? (
            <Button variant="ghost" className="mt-2" onClick={() => setAll((a) => !a)}>
              {all ? 'Show fewer' : `Show all (${items.length})`}
            </Button>
          ) : null}
        </CardBody>
      )}
    </Card>
  );
}
