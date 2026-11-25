import { useState } from 'react';
import type { OrgMember, OrgRole } from '@/shared/contracts/org-membership.ts';
import { Button, Dialog, DialogContent, Form, useFormErrors } from '@/web/ui/index.ts';
import { RolePicker } from './role-picker.tsx';

/** Edits one member's roles with the invite dialog's picker. */
export function ChangeRolesDialog({
  member,
  name,
  onClose,
  onSave,
}: {
  member: OrgMember | null;
  name: string;
  onClose: () => void;
  /** True when it saved; the caller toasts a failure and the dialog keeps the draft. */
  onSave: (member: OrgMember, roles: OrgRole[]) => Promise<boolean>;
}) {
  const [picked, setPicked] = useState<{ id: string; roles: OrgRole[] } | null>(null);
  const [saving, setSaving] = useState(false);
  // The picker starts from the member's roles each time the dialog opens on someone.
  const roles = member ? (picked?.id === member.id ? picked.roles : member.roles) : [];
  const check = useFormErrors({ roles: roles.length ? undefined : 'Choose at least one role.' });
  const dirty = member ? roles.join() !== member.roles.join() : false;

  function close() {
    setPicked(null);
    check.reset();
    onClose();
  }

  async function save() {
    if (!member) return;
    setSaving(true);
    const saved = await onSave(member, roles);
    setSaving(false);
    if (saved) close();
  }

  return (
    <Dialog open={member !== null} dirty={dirty} onOpenChange={(o) => !o && close()}>
      <DialogContent
        title={`Change roles for ${name}`}
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="change-roles" loading={saving} disabled={!dirty}>
              Save
            </Button>
          </>
        }
      >
        <Form id="change-roles" {...check.form} onValid={save}>
          <RolePicker
            roles={roles}
            onChange={(next) => member && setPicked({ id: member.id, roles: next })}
            error={check.errors.roles}
            idPrefix="member-role"
          />
        </Form>
      </DialogContent>
    </Dialog>
  );
}
