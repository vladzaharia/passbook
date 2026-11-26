import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ClaimType } from '@/shared/contracts/idp-access.ts';
import { GROUP_COPY } from '@/shared/copy/idp-platform.ts';
import { removeClaimConfirm } from '@/web/lib/confirms-idp.ts';
import { ENTITY } from '@/web/lib/entities.ts';
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
import { ClaimDialog, type ClaimDraft, rawOf } from './claim-dialog.tsx';
import { useGroupActions, useGroupClaims } from './queries.ts';

const TYPE_LABEL: Record<ClaimType, string> = {
  text: 'Text',
  number: 'Number',
  boolean: 'Yes or no',
  json: 'JSON',
};

const shown = (type: ClaimType, value: unknown): string => {
  const text = type === 'json' ? JSON.stringify(value) : String(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

/** Claims on the group reach every app that signs in with Polaris ID; values are shown to platform admins only. */
export function GroupClaimsCard({ groupKey }: { groupKey: string }) {
  const claims = useGroupClaims(groupKey);
  const { setClaims } = useGroupActions();
  const [draft, setDraft] = useState<ClaimDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const entries = Object.entries(claims.data?.claims ?? {});
  const other = claims.data?.otherKeys ?? 0;
  const copy = removeClaimConfirm(removing ?? '');
  return (
    <Card id="claims">
      <CardHeader
        title="Claims"
        actions={
          <Button
            size="sm"
            variant="outline"
            iconStart={<Plus aria-hidden />}
            onClick={() => {
              setEditing(false);
              setDraft({ key: 'passbook_', type: 'text', raw: '' });
            }}
          >
            Add claim
          </Button>
        }
      />
      <CardBody>
        {claims.isPending ? (
          <SkeletonRows label="Loading claims" />
        ) : claims.isError ? (
          <ErrorState
            inline
            subject="claims"
            error={claims.error}
            onRetry={() => claims.refetch()}
          />
        ) : entries.length === 0 ? (
          <EmptyState inline art={ENTITY.group.art} title={GROUP_COPY.noClaims} />
        ) : (
          <ListRows label="Claims">
            {entries.map(([key, claim]) => (
              <ListRow
                key={key}
                title={<code className="font-mono text-sm">{key}</code>}
                meta={
                  <>
                    {TYPE_LABEL[claim.type]} ·{' '}
                    <span className="break-all">{shown(claim.type, claim.value)}</span>
                  </>
                }
                trailing={
                  <RowActions
                    label={`Actions for ${key}`}
                    actions={[
                      {
                        label: 'Edit',
                        icon: Pencil,
                        onSelect: () => {
                          setEditing(true);
                          setDraft({ key, type: claim.type, raw: rawOf(claim.type, claim.value) });
                        },
                      },
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
            {other} other {other === 1 ? 'claim' : 'claims'} set in Polaris ID.
          </p>
        ) : null}
      </CardBody>
      <ClaimDialog
        groupKey={groupKey}
        draft={draft}
        editing={editing}
        onClose={() => setDraft(null)}
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
          const sent = await setClaims.mutateAsync({
            key: groupKey,
            change: { set: { [removing]: null } },
          });
          toast.success(sent.dryRun ? GROUP_COPY.dryRun : 'Claim removed');
        }}
      />
    </Card>
  );
}
