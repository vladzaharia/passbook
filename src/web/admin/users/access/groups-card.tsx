import { Plus, Users, X } from 'lucide-react';
import { useState } from 'react';
import { IDP_COPY } from '@/shared/copy/idp.ts';
import { removeGroupMemberConfirm } from '@/web/lib/confirms-idp.ts';
import { UserMessageError } from '@/web/lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  FormDialog,
  FormField,
  ListRow,
  ListRows,
  Select,
  SkeletonRows,
  toast,
} from '@/web/ui/index.ts';
import { type UserGroup, useGroupMembership, useUserGroups } from './queries.ts';

/** The custom groups the user was added to by hand, with Add and Remove. Org rules show on the group's page. */
export function GroupsCard({ userId, person }: { userId: string; person: string }) {
  const groups = useUserGroups(userId, true);
  const { add, remove } = useGroupMembership(userId);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const [removing, setRemoving] = useState<UserGroup | null>(null);

  if (groups.isError) return null;
  const held = groups.data?.held ?? [];
  const left = (groups.data?.choices ?? []).filter((c) => !held.some((h) => h.key === c.key));
  const addButton =
    left.length > 0 ? (
      <Button
        size="sm"
        variant="ghost"
        iconStart={<Plus aria-hidden />}
        onClick={() => setAdding(true)}
      >
        Add
      </Button>
    ) : null;

  return (
    <Card>
      <CardHeader title="Groups" actions={addButton} />
      <CardBody>
        {groups.isPending ? (
          <SkeletonRows rows={2} label="Loading groups" />
        ) : held.length === 0 ? (
          <EmptyState inline art="people" title={IDP_COPY.noGroups} />
        ) : (
          <ListRows label="Groups">
            {held.map((g) => (
              <ListRow
                key={g.key}
                leading={<Users aria-hidden />}
                title={g.label}
                trailing={
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove from ${g.label}`}
                    iconStart={<X aria-hidden />}
                    onClick={() => setRemoving(g)}
                  >
                    Remove
                  </Button>
                }
              />
            ))}
          </ListRows>
        )}
      </CardBody>
      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        size="sm"
        title="Add to group"
        submitLabel="Add"
        dirty={pick !== ''}
        onClose={() => setPick('')}
        onSubmit={async () => {
          if (!pick) throw new UserMessageError('Choose a group.');
          await add.mutateAsync(pick);
          toast.success('Added to group');
        }}
      >
        <FormField label="Group">
          {(p) => (
            <Select
              {...p}
              value={pick}
              onValueChange={setPick}
              placeholder="Choose a group"
              options={left.map((c) => ({ value: c.key, label: c.label }))}
            />
          )}
        </FormField>
      </FormDialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        {...(removing
          ? removeGroupMemberConfirm(removing.label, person)
          : { title: '', confirmLabel: '', description: '' })}
        destructive
        onConfirm={async () => {
          if (removing) await remove.mutateAsync(removing);
        }}
      />
    </Card>
  );
}
