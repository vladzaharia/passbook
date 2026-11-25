import { useState } from 'react';
import { InviteOrgMemberSchema, type OrgRole } from '@/shared/contracts/org-membership.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Button, Dialog, DialogContent, Form, toast, useFormErrors } from '@/web/ui/index.ts';
import { EmailChips } from './email-chips.tsx';
import { addEmails, type EmailChip } from './invite-emails.ts';
import { RolePicker } from './role-picker.tsx';
import type { SendInvite } from './use-org-access.ts';

/** Invites each address in turn with the chosen roles; the ones the server refuses stay, with why. */
export function InviteDialog({
  open,
  onOpenChange,
  pending,
  onInvite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onInvite: SendInvite;
}) {
  const [chips, setChips] = useState<EmailChip[]>([]);
  const [draft, setDraft] = useState('');
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const all = addEmails(chips, draft);
  const emailError =
    all.length === 0
      ? 'Enter an email address.'
      : all.some((chip) => !chip.valid)
        ? 'Enter valid email addresses.'
        : undefined;
  const check = useFormErrors({
    emails: emailError,
    roles: InviteOrgMemberSchema.shape.roles.safeParse(roles).success
      ? undefined
      : 'Choose at least one role.',
  });

  function close() {
    onOpenChange(false);
    setChips([]);
    setDraft('');
    setRoles([]);
    setRefused({});
    check.reset();
  }

  async function send() {
    const failed: Record<string, string> = {};
    let sent = 0;
    // The signed-in person changed mid-send: the answer is not theirs to see.
    let dropped = false;
    for (const chip of all) {
      try {
        if (await onInvite({ email: chip.email, roles })) sent += 1;
        else dropped = true;
      } catch (error) {
        failed[chip.email] = errorMessage(error);
      }
    }
    const left = all.filter((chip) => failed[chip.email]);
    if (sent > 0) toast.sent(sent === 1 ? 'Invitation sent' : `${sent} invitations sent`);
    if (dropped || left.length === 0) {
      close();
      return;
    }
    if (sent === 0) toast.error(Object.values(failed)[0], 'Could not invite');
    setChips(left);
    setDraft('');
    setRefused(failed);
    return 'refused' as const;
  }

  return (
    <Dialog
      open={open}
      dirty={chips.length > 0 || draft.trim() !== '' || roles.length > 0}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        title="Invite member"
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="invite-member" loading={pending}>
              {all.length > 1 ? `Invite ${all.length}` : 'Invite'}
            </Button>
          </>
        }
      >
        <Form id="invite-member" {...check.form} onValid={send} className="flex flex-col gap-4">
          <EmailChips
            chips={chips}
            onChange={(next) => {
              setChips(next);
              setRefused({});
            }}
            draft={draft}
            onDraft={setDraft}
            error={check.errors.emails}
            refused={refused}
          />
          <RolePicker
            roles={roles}
            onChange={setRoles}
            error={check.errors.roles}
            idPrefix="invite-role"
          />
        </Form>
      </DialogContent>
    </Dialog>
  );
}
