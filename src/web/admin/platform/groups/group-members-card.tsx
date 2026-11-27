import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { GroupMember } from '@/shared/contracts/idp-access.ts';
import { GROUP_COPY } from '@/shared/copy/idp-platform.ts';
import { removeGroupMemberConfirm } from '@/web/lib/confirms-idp.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { personLabel } from '@/web/lib/format.ts';
import { EntityPicker } from '@/web/ui/entity-picker.tsx';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  EntityAvatar,
  ErrorState,
  FormDialog,
  FormField,
  Input,
  ListRow,
  ListRows,
  RowActions,
  SegmentedControl,
  SkeletonRows,
  toast,
  useFormErrors,
} from '@/web/ui/index.ts';
import { useUser } from '../../users/queries.ts';
import { useGroupActions, useGroupMembers } from './queries.ts';

/** A short, safe stand-in for a Polaris ID subject. */
const shortSubject = (subject: string) =>
  subject.length > 12 ? `${subject.slice(0, 8)}…${subject.slice(-4)}` : subject;

function MemberLine({
  member,
  name,
  onRemove,
}: {
  member: GroupMember;
  /** The PassBook user's name once known. */
  name: string | null;
  onRemove: () => void;
}) {
  const linked = member.userId !== null;
  const title = name ?? (linked ? 'PassBook user' : 'Polaris ID account');
  return (
    <ListRow
      rowId={member.id}
      leading={
        linked && name ? (
          <EntityAvatar kind="user" id={member.userId ?? ''} name={name} size={24} />
        ) : (
          <ENTITY.user.icon aria-hidden className="size-4 text-fg-muted" />
        )
      }
      title={title}
      meta={
        <>
          {linked ? null : <code className="font-mono">{shortSubject(member.subject)}</code>}
          {member.source === 'invitation' ? ' From an invitation' : null}
        </>
      }
      trailing={
        <RowActions
          label={`Actions for ${title}`}
          actions={[{ label: 'Remove', icon: Trash2, destructive: true, onSelect: onRemove }]}
        />
      }
    />
  );
}

function LinkedMemberRow({ member, onRemove }: { member: GroupMember; onRemove: () => void }) {
  const user = useUser(member.userId ?? '');
  return (
    <MemberLine
      member={member}
      name={user.data ? personLabel(user.data) : null}
      onRemove={onRemove}
    />
  );
}

const MemberRow = ({ member, onRemove }: { member: GroupMember; onRemove: () => void }) =>
  member.userId === null ? (
    <MemberLine member={member} name={null} onRemove={onRemove} />
  ) : (
    <LinkedMemberRow member={member} onRemove={onRemove} />
  );

/** People added by hand: a PassBook user, or a Polaris ID subject PassBook does not know. */
export function GroupMembersCard({ groupKey }: { groupKey: string }) {
  const members = useGroupMembers(groupKey);
  const { removeMember } = useGroupActions();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<GroupMember | null>(null);
  const items = members.data?.items ?? [];
  const copy = removeGroupMemberConfirm(groupKey, 'this member');
  return (
    <Card>
      <CardHeader
        title="Members"
        actions={
          <Button
            size="sm"
            variant="outline"
            iconStart={<Plus aria-hidden />}
            onClick={() => setAdding(true)}
          >
            Add member
          </Button>
        }
      />
      <CardBody>
        {members.isPending ? (
          <SkeletonRows label="Loading members" />
        ) : members.isError ? (
          <ErrorState
            inline
            subject="members"
            error={members.error}
            onRetry={() => members.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState inline art={ENTITY.user.art} title={GROUP_COPY.noMembers} />
        ) : (
          <ListRows label="Manual members">
            {items.map((m) => (
              <MemberRow key={m.id} member={m} onRemove={() => setRemoving(m)} />
            ))}
          </ListRows>
        )}
      </CardBody>
      <AddMemberDialog groupKey={groupKey} open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={copy.title}
        description={copy.description}
        confirmLabel={copy.confirmLabel}
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await removeMember.mutateAsync({ key: groupKey, id: removing.id });
          toast.success('Member removed');
        }}
      />
    </Card>
  );
}

function AddMemberDialog({
  groupKey,
  open,
  onOpenChange,
}: {
  groupKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { addMember } = useGroupActions();
  const [by, setBy] = useState<'user' | 'subject'>('user');
  const [userId, setUserId] = useState<string>();
  const [subject, setSubject] = useState('');
  const missing = by === 'user' ? !userId : !subject.trim();
  const check = useFormErrors(
    missing ? { member: by === 'user' ? 'Pick a user.' : 'Enter a subject.' } : {},
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add member"
      size="sm"
      dirty={Boolean(userId) || subject.trim() !== ''}
      check={check}
      submitLabel="Add member"
      busy={addMember.isPending}
      onClose={() => {
        setBy('user');
        setUserId(undefined);
        setSubject('');
      }}
      onSubmit={async () => {
        const member = by === 'user' && userId ? { userId } : { subject: subject.trim() };
        await addMember.mutateAsync({ key: groupKey, member });
        toast.success('Member added');
        onOpenChange(false);
      }}
    >
      {({ errors }) => (
        <>
          <SegmentedControl
            label="Add by"
            value={by}
            onValueChange={setBy}
            options={[
              { value: 'user', label: 'PassBook user' },
              { value: 'subject', label: 'Polaris ID account' },
            ]}
          />
          <FormField
            label={by === 'user' ? 'User' : 'Subject'}
            required
            error={check.errors.member ?? errors.userId ?? errors.subject}
            help={by === 'subject' ? 'The account id from Polaris ID.' : undefined}
          >
            {(control) =>
              by === 'user' ? (
                <EntityPicker
                  {...control}
                  kind="user"
                  value={userId}
                  onValueChange={setUserId}
                  placeholder="Pick a user"
                />
              ) : (
                <Input
                  {...control}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                />
              )
            }
          </FormField>
        </>
      )}
    </FormDialog>
  );
}
