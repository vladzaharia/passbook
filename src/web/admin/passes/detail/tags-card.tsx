import { Nfc, Plus } from 'lucide-react';
import { useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { useInsertHighlight } from '@/web/lib/motion.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  ListRows,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { AddTagDialog } from '../../tags/add-tag-dialog.tsx';
import { usePassTags, useTagsEnabled } from '../../tags/api.ts';
import { useTagActions } from '../../tags/tag-actions.tsx';
import { TagRow } from '../../tags/tag-row.tsx';

/** Active first, newest first, then lost. */
const order = <T extends { state: string; binding: { boundAt: number } | null }>(a: T, b: T) =>
  Number(a.state === 'lost') - Number(b.state === 'lost') ||
  (b.binding?.boundAt ?? 0) - (a.binding?.boundAt ?? 0);

/**
 * Tags that work with this pass: its own, and the holder's person-wide ones. Assign sends a
 * request to a scanner; the new row arrives with the insert wash and the tag's ping.
 */
export function TagsCard({ pass, readOnly }: { pass: PassDetailDto; readOnly: boolean }) {
  const enabled = useTagsEnabled(pass.orgId);
  const query = usePassTags(pass.id);
  const actions = useTagActions();
  const [assigning, setAssigning] = useState(0);
  const [open, setOpen] = useState(false);
  const rows = [...(query.data?.items ?? [])].sort(order);
  const fresh = useInsertHighlight(rows.map((t) => t.id));
  const voided = pass.status === 'voided';
  const holderName = pass.ownerName ?? pass.ownerEmail ?? pass.holderEmail ?? 'the holder';
  const canAssign = !readOnly && !voided;
  const assign = () => {
    setAssigning((n) => n + 1);
    setOpen(true);
  };
  if (!enabled && rows.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title={TAG_COPY.card}
        actions={
          canAssign && rows.length > 0 ? (
            <Button variant="ghost" size="sm" iconStart={<Plus aria-hidden />} onClick={assign}>
              {TAG_COPY.assign}
            </Button>
          ) : null
        }
      />
      <CardBody>
        {query.isPending ? (
          <SkeletonRows rows={2} label="Loading tags" />
        ) : query.isError ? (
          <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            inline
            art="badge"
            title={TAG_COPY.empty}
            action={
              canAssign ? (
                <Button variant="outline" iconStart={<Nfc aria-hidden />} onClick={assign}>
                  {TAG_COPY.assign}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ListRows label={TAG_COPY.card}>
            {rows.map((tag) => (
              <TagRow
                key={tag.id}
                tag={tag}
                actions={actions}
                readOnly={readOnly}
                isNew={fresh.has(tag.id)}
              />
            ))}
          </ListRows>
        )}
      </CardBody>
      {actions.dialog}
      {canAssign ? (
        <AddTagDialog
          key={assigning}
          open={open}
          onOpenChange={setOpen}
          target={{
            passId: pass.id,
            orgId: pass.orgId,
            holderName,
            hasAccount: pass.ownerUserId !== null,
          }}
        />
      ) : null}
    </Card>
  );
}
