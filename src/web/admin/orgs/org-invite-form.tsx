import { useState } from 'react';
import { InviteOrgMemberSchema, type OrgRole } from '@/shared/contracts/org-membership.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Button, CheckboxField, Form, FormField, Input, useFormErrors } from '@/web/ui/index.ts';
import { ROLE_LABELS, ROLES } from './org-roles.ts';

const ERROR_ID = 'invite-roles-error';

/** Sends the draft; true when it went, so the form clears. A thrown error stays under the field. */
export type SendInvite = (body: { email: string; roles: OrgRole[] }) => Promise<boolean>;

export function InviteForm({ pending, onInvite }: { pending: boolean; onInvite: SendInvite }) {
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [message, setMessage] = useState('');
  const [server, setServer] = useState('');
  const parsed = InviteOrgMemberSchema.safeParse({ email, roles });
  const emailOk = InviteOrgMemberSchema.shape.email.safeParse(email).success;
  const check = useFormErrors({
    email: emailOk ? undefined : 'Enter a valid email address.',
    roles: roles.length ? undefined : 'Choose at least one role.',
  });

  async function save() {
    setMessage('');
    setServer('');
    if (!parsed.success) return;
    try {
      if (!(await onInvite(parsed.data))) return;
    } catch (error) {
      setServer(errorMessage(error));
      return 'refused' as const;
    }
    setEmail('');
    setRoles([]);
    check.reset();
    setMessage('Invitation sent.');
    return;
  }

  return (
    <Form
      {...check.form}
      onValid={save}
      className="flex flex-col gap-3 border-t border-border pt-3"
    >
      <h4 className="text-sm font-semibold text-fg-strong">Invite a member</h4>
      <FormField label="Email" error={check.errors.email}>
        {(props) => (
          <Input
            {...props}
            type="text"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </FormField>
      <fieldset
        className="flex flex-col gap-2"
        aria-describedby={check.errors.roles ? ERROR_ID : undefined}
      >
        <legend className="mb-2 text-sm font-medium">Roles</legend>
        {ROLES.map((role, index) => (
          <CheckboxField
            key={role}
            label={ROLE_LABELS[role]}
            aria-invalid={(index === 0 && Boolean(check.errors.roles)) || undefined}
            checked={roles.includes(role)}
            onCheckedChange={(checked) =>
              setRoles((current) =>
                checked === true ? [...current, role] : current.filter((item) => item !== role),
              )
            }
          />
        ))}
        {check.errors.roles ? (
          <p id={ERROR_ID} className="text-xs text-danger">
            {check.errors.roles}
          </p>
        ) : null}
      </fieldset>
      {server ? (
        <p role="alert" className="text-sm text-danger">
          {server}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-fg-muted">
          {message}
        </p>
      ) : null}
      <div>
        <Button type="submit" size="sm" loading={pending}>
          Invite member
        </Button>
      </div>
    </Form>
  );
}
