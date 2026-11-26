import { Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { IDP_COPY } from '@/shared/copy/idp.ts';
import { removeClaimConfirm } from '@/web/lib/confirms-idp.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ListRow,
  ListRows,
  RowActions,
  SkeletonRows,
  toast,
} from '@/web/ui/index.ts';
import { useClaims, useSetClaims } from '../access/queries.ts';
import { ClaimDialog } from './claim-dialog.tsx';

const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/** Key, value and type of the claims PassBook manages; others' claims are only counted. */
export function ClaimsCard({ userId }: { userId: string }) {
  const claims = useClaims(userId, true);
  const set = useSetClaims(userId);
  const [editing, setEditing] = useState<{ key: string } | 'new' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  if (claims.isError) return null;
  const entries = Object.entries(claims.data?.claims ?? {});
  const other = claims.data?.otherKeys ?? 0;

  return (
    <Card>
      <CardHeader
        title="Claims"
        actions={
          <Button
            size="sm"
            variant="ghost"
            iconStart={<Plus aria-hidden />}
            onClick={() => setEditing('new')}
          >
            Add claim
          </Button>
        }
      />
      <CardBody>
        {claims.isPending ? (
          <SkeletonRows rows={2} label="Loading claims" />
        ) : entries.length === 0 ? (
          <EmptyState inline art="log" title={IDP_COPY.noClaims} />
        ) : (
          <ListRows label="Claims">
            {entries.map(([key, claim]) => (
              <ListRow
                key={key}
                leading={<Tag aria-hidden />}
                title={<span className="font-mono text-xs">{key}</span>}
                pills={<span className="text-xs text-fg-muted">{claim.type}</span>}
                meta={show(claim.value)}
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
          <p className="mt-3 text-xs text-fg-muted">{other} other claims set in Polaris ID</p>
        ) : null}
      </CardBody>
      <ClaimDialog
        key={editing === null ? 'closed' : editing === 'new' ? 'new' : editing.key}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        existing={editing && editing !== 'new' ? editing.key : null}
        current={editing && editing !== 'new' ? claims.data?.claims[editing.key] : undefined}
        taken={entries.map(([key]) => key)}
        onSave={async (key, value) => {
          await set.mutateAsync({ set: { [key]: value } });
          toast.success('Claim saved');
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        {...(removing
          ? removeClaimConfirm(removing)
          : { title: '', confirmLabel: '', description: '' })}
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await set.mutateAsync({ set: { [removing]: null } });
          toast.success('Claim removed');
        }}
      />
    </Card>
  );
}
