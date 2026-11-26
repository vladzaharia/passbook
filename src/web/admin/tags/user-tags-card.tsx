import { Plus } from 'lucide-react';
import { useState } from 'react';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { useInsertHighlight } from '@/web/lib/motion.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  ListRows,
  SkeletonRows,
} from '@/web/ui/index.ts';
import { usePass } from '../passes/api.ts';
import { AddTagDialog } from './add-tag-dialog.tsx';
import { useTagActions } from './tag-actions.tsx';
import { TagRow } from './tag-row.tsx';
import { useUserTagList } from './tags-extra-api.ts';

interface UserPass {
  id: string;
  orgName: string;
  status: string;
}

/**
 * Tags on the user page: the ones that work with all of the person's passes, then the ones on a
 * single pass. Across all organizations, so each row says which organization it belongs to.
 */
export function UserTagsCard({
  userId,
  name,
  passes,
  passCount,
}: {
  userId: string;
  name: string;
  passes: readonly UserPass[];
  passCount: number;
}) {
  const live = passes.filter((p) => p.status !== 'voided');
  const query = useUserTagList(userId);
  const { isPending, isError, error } = query;
  const tags = query.data?.items ?? [];
  const actions = useTagActions({ passes: passCount });
  const [assigning, setAssigning] = useState(0);
  const [open, setOpen] = useState(false);
  const fresh = useInsertHighlight(tags.map((t) => t.id));
  const person = tags.filter((t) => t.binding?.scope === 'user');
  const single = tags.filter((t) => t.binding?.scope !== 'user');
  const row = (tag: (typeof tags)[number]) => (
    <TagRow
      key={tag.id}
      tag={tag}
      actions={actions}
      readOnly={false}
      isNew={fresh.has(tag.id)}
      worksWith={tag.binding?.scope === 'user' ? 'none' : 'chip'}
      extra={<span className="block">{tag.orgName}</span>}
    />
  );
  return (
    <Card>
      <CardHeader
        title={TAG_COPY.card}
        actions={
          live.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              iconStart={<Plus aria-hidden />}
              onClick={() => {
                setAssigning((n) => n + 1);
                setOpen(true);
              }}
            >
              {TAG_COPY.assign}
            </Button>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-4">
        {isPending ? (
          <SkeletonRows rows={2} label="Loading tags" />
        ) : isError ? (
          <ErrorState inline error={error} />
        ) : tags.length === 0 ? (
          <EmptyState inline art="badge" title={TAG_COPY.empty} />
        ) : (
          <>
            {person.length > 0 ? (
              <ListRows label={TAG_COPY.card}>{person.map(row)}</ListRows>
            ) : null}
            {single.length > 0 ? (
              <div className="flex flex-col gap-2 border-t border-border pt-4">
                <h3 className="text-xs font-medium text-fg-muted">{TAG_COPY.userGroup}</h3>
                <ListRows label={TAG_COPY.userGroup}>{single.map(row)}</ListRows>
              </div>
            ) : null}
          </>
        )}
      </CardBody>
      {actions.dialog}
      {open ? (
        <AssignToPerson
          key={assigning}
          userId={userId}
          name={name}
          passes={live}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Card>
  );
}

/** Assign person-wide; the first step picks an organization when the person has passes in several. */
function AssignToPerson({
  name,
  passes,
  onClose,
}: {
  userId: string;
  name: string;
  passes: readonly UserPass[];
  onClose: () => void;
}) {
  const orgs = [...new Set(passes.map((p) => p.orgName))];
  const several = orgs.length > 1;
  const [org, setOrg] = useState<string | undefined>(several ? undefined : orgs[0]);
  const first = passes.find((p) => p.orgName === org);
  const pass = usePass(first?.id ?? '');
  const close = (open: boolean) => !open && onClose();
  if (!several && !pass.data) {
    return (
      <Dialog open onOpenChange={close}>
        <DialogContent title={TAG_COPY.dialog.title}>
          {pass.isError ? (
            <ErrorState inline error={pass.error} onRetry={() => void pass.refetch()} />
          ) : (
            <SkeletonRows rows={2} label="Loading" />
          )}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <AddTagDialog
      open
      onOpenChange={close}
      fixed="person"
      target={{
        passId: pass.data?.id ?? '',
        orgId: pass.data?.orgId ?? '',
        holderName: name,
        hasAccount: true,
      }}
      {...(several
        ? {
            org: {
              options: orgs,
              value: org,
              onChange: setOrg,
              ready: Boolean(pass.data),
              error: pass.isError ? pass.error : undefined,
              onRetry: () => void pass.refetch(),
            },
          }
        : {})}
    />
  );
}
