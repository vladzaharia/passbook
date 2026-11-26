import { useState } from 'react';
import { type Group, GroupFriendlyNameSchema } from '@/shared/contracts/idp-access.ts';
import { GROUP_COPY } from '@/shared/copy/idp-platform.ts';
import { deleteGroupConfirm } from '@/web/lib/confirms-idp.ts';
import {
  FormDialog,
  FormField,
  Input,
  TypedConfirmDialog,
  toast,
  useFormErrors,
} from '@/web/ui/index.ts';
import { groupLabel } from './group-ui.tsx';
import { useGroupActions } from './queries.ts';

/** The display name only: the Polaris ID name never changes. */
export function RenameGroupDialog({
  group,
  onClose,
}: {
  group: Group | null;
  onClose: () => void;
}) {
  const { rename } = useGroupActions();
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? (group ? groupLabel(group) : '');
  const parsed = GroupFriendlyNameSchema.safeParse(name);
  const check = useFormErrors(parsed.success ? {} : { name: 'Use 2 to 50 characters.' });
  return (
    <FormDialog
      open={group !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Rename group"
      size="sm"
      dirty={group !== null && draft !== null && draft.trim() !== groupLabel(group)}
      check={check}
      submitLabel="Save"
      busy={rename.isPending}
      onClose={() => setDraft(null)}
      onSubmit={async () => {
        if (!group || !parsed.success) return;
        const sent = await rename.mutateAsync({ key: group.key, friendlyName: parsed.data });
        toast.success(sent.dryRun ? GROUP_COPY.dryRun : 'Group renamed');
        onClose();
      }}
    >
      {({ errors }) => (
        <FormField
          label="Name"
          required
          error={check.errors.name ?? errors.friendlyName}
          help={GROUP_COPY.keyFixed}
        >
          {(control) => (
            <Input
              {...control}
              data-autofocus
              autoComplete="off"
              maxLength={50}
              value={name}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </FormField>
      )}
    </FormDialog>
  );
}

/** Typed confirm. A refusal (members, rules, other apps) shows in the dialog and the group stays. */
export function DeleteGroupDialog({
  group,
  onClose,
  onDeleted,
}: {
  group: Group | null;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { remove } = useGroupActions();
  const name = group ? groupLabel(group) : '';
  const copy = deleteGroupConfirm(name);
  return (
    <TypedConfirmDialog
      open={group !== null}
      onOpenChange={(open) => !open && onClose()}
      title={copy.title}
      description={`${copy.description} ${GROUP_COPY.otherApps}`}
      confirmLabel={copy.confirmLabel}
      word={group?.key ?? 'group'}
      onConfirm={async () => {
        if (!group) return;
        const sent = await remove.mutateAsync(group.key);
        toast.success(sent.dryRun ? GROUP_COPY.dryRun : `${name} deleted`);
        onDeleted?.();
      }}
    />
  );
}
