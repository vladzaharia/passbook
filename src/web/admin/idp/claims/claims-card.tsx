import type { UseQueryResult } from '@tanstack/react-query';
import { Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ClaimsView, UpdateClaims } from '@/shared/contracts/idp-access.ts';
import { IDP_COPY } from '@/shared/copy/idp.ts';
import { plural } from '@/shared/plural.ts';
import { removeClaimConfirm } from '@/web/lib/confirms-idp.ts';
import { requestStepUp } from '@/web/lib/step-up.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  ListRow,
  ListRows,
  RowActions,
  SkeletonRows,
  toast,
} from '@/web/ui/index.ts';
import { CLAIM_TYPE_LABEL, ClaimDialog } from './claim-dialog.tsx';
import type { ClaimsAccess } from './use-can-read-claims.ts';

const shown = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

/** The claims PassBook manages on a user or a group: key, type and value; others' claims are only counted. */
export function ClaimsCard({
  query,
  save,
  namespaced = false,
  hideOnError = false,
  access = 'ok',
  id,
}: {
  query: UseQueryResult<ClaimsView>;
  /** Sends the change; `dryRun` is true while Polaris ID changes are in dry run. */
  save: (change: UpdateClaims) => Promise<{ dryRun?: boolean }>;
  namespaced?: boolean;
  /** The user card hides when the binding is absent. */
  hideOnError?: boolean;
  /** Without a recent Polaris ID sign-in the card asks for one instead of loading. */
  access?: ClaimsAccess;
  id?: string;
}) {
  const [editing, setEditing] = useState<{ key: string } | 'new' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  if (hideOnError && query.isError) return null;
  const entries = Object.entries(query.data?.claims ?? {});
  const other = query.data?.otherKeys ?? 0;
  const copy = removeClaimConfirm(removing ?? '');

  return (
    <Card id={id}>
      <CardHeader
        title="Claims"
        actions={
          access !== 'ok' ? null : (
            <Button
              size="sm"
              variant="ghost"
              iconStart={<Plus aria-hidden />}
              onClick={() => setEditing('new')}
            >
              Add claim
            </Button>
          )
        }
      />
      <CardBody>
        {access === 'breakglass' ? (
          <EmptyState inline art="log" title={IDP_COPY.claimsBreakGlass} />
        ) : access === 'stale' ? (
          <EmptyState
            inline
            art="log"
            title={IDP_COPY.claimsStale}
            action={
              <Button size="sm" variant="outline" onClick={() => requestStepUp(undefined)}>
                {IDP_COPY.claimsSignIn}
              </Button>
            }
          />
        ) : query.isPending ? (
          <SkeletonRows rows={2} label="Loading claims" />
        ) : query.isError ? (
          <ErrorState
            inline
            subject="claims"
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : entries.length === 0 ? (
          <EmptyState inline art="log" title={IDP_COPY.noClaims} />
        ) : (
          <ListRows label="Claims">
            {entries.map(([key, claim]) => (
              <ListRow
                key={key}
                leading={<Tag aria-hidden />}
                title={<code className="font-mono text-xs">{key}</code>}
                meta={
                  <>
                    {CLAIM_TYPE_LABEL[claim.type]} ·{' '}
                    <span className="break-all">{shown(claim.value)}</span>
                  </>
                }
                trailing={
                  <RowActions
                    label={`Actions for ${key}`}
                    actions={[
                      { label: 'Edit', icon: Pencil, onSelect: () => setEditing({ key }) },
                      {
                        label: 'Remove',
                        icon: Trash2,
                        destructive: true,
                        onSelect: () => setRemoving(key),
                      },
                    ]}
                  />
                }
              />
            ))}
          </ListRows>
        )}
        {other > 0 ? (
          <p className="mt-3 text-xs text-fg-muted">
            {plural(other, 'other claim')} set in Polaris ID.
          </p>
        ) : null}
      </CardBody>
      <ClaimDialog
        key={editing === null ? 'closed' : editing === 'new' ? 'new' : editing.key}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        existing={editing && editing !== 'new' ? editing.key : null}
        current={editing && editing !== 'new' ? query.data?.claims[editing.key] : undefined}
        taken={entries.map(([key]) => key)}
        namespaced={namespaced}
        onSave={async (key, value) => {
          const sent = await save({ set: { [key]: value } });
          toast.success(sent.dryRun ? IDP_COPY.dryRun : 'Claim saved');
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={copy.title}
        description={copy.description}
        confirmLabel={copy.confirmLabel}
        destructive
        onConfirm={async () => {
          if (!removing) return;
          const sent = await save({ set: { [removing]: null } });
          toast.success(sent.dryRun ? IDP_COPY.dryRun : 'Claim removed');
        }}
      />
    </Card>
  );
}
