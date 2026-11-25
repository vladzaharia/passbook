import { useState } from 'react';
import { InviteOrgMemberSchema, type OrgRole } from '@/shared/contracts/org-membership.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Button, CheckboxField, Form, FormField, Input, useFormErrors } from '@/web/ui/index.ts';
import { ROLE_LABELS, ROLES } from './org-roles.ts';

const ERROR_ID = 'invite-roles-error';

/** Sends the draft; true when it went, so the form clears. A thrown error stays under the field. */
export type SendInvite = (body: {
  email: string;
  roles: OrgRole[];
  developer?: boolean;
}) => Promise<boolean>;

export function InviteForm({
  pending,
  onInvite,
  developers = false,
}: {
  pending: boolean;
  onInvite: SendInvite;
  /** Polaris ID can enrol developers and the plan has seats: offer developer access. */
  developers?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [developer, setDeveloper] = useState(false);
  const [message, setMessage] = useState('');
  const [server, setServer] = useState('');
  const address = InviteOrgMemberSchema.shape.email.safeParse(email);
  // Developer access alone is an invitation: roles are only needed to join the org as well.
  const rolesOk =
    roles.length > 0 ? InviteOrgMemberSchema.safeParse({ email, roles }).success : developer;
  const check = useFormErrors({
    email: address.success ? undefined : 'Enter a valid email address.',
    roles: rolesOk ? undefined : 'Choose at least one role.',
  });

  async function save() {
    setMessage('');
    setServer('');
    if (!address.success || !rolesOk) return;
    try {
      if (!(await onInvite({ email: address.data, roles, ...(developer ? { developer } : {}) })))
        return;
    } catch (error) {
      setServer(errorMessage(error));
      return 'refused' as const;
    }
    setEmail('');
    setRoles([]);
    setDeveloper(false);
    check.reset();
    setMessage('Invitation sent.');
    return;
  }

  return (
    <Form
      {...check.form}
      onValid={save}
      className="flex max-w-md flex-col gap-3 border-t border-border pt-3"
    >
      <h3 className="text-sm font-semibold text-fg-strong">Invite a member</h3>
      <FormField label="Email" error={check.errors.email}>
        {(props) => (
          <Input
            {...props}
            data-draft
            type="text"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </FormField>
      <fieldset
        className="grid gap-2 sm:grid-cols-2"
        aria-describedby={check.errors.roles ? ERROR_ID : undefined}
      >
        <legend className="mb-2 text-sm font-medium sm:col-span-2">Roles</legend>
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
          <p id={ERROR_ID} className="text-xs text-danger sm:col-span-2">
            {check.errors.roles}
          </p>
        ) : null}
      </fieldset>
      {developers ? (
        // The roles grid's rows are 8 px apart: this row keeps the same rhythm under it.
        <div className="-mt-1">
          <CheckboxField
            label="Developer access"
            checked={developer}
            onCheckedChange={(checked) => setDeveloper(checked === true)}
          />
        </div>
      ) : null}
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
