import { useState } from 'react';
import { InviteOrgMemberSchema, type OrgRole } from '@/shared/contracts/org-membership.ts';
import { CheckboxField } from '@/web/ui/index.ts';
import { InviteWizard } from '../users/invite/invite-wizard.tsx';
import { ROLE_LABELS } from './org-roles.ts';
import { RolePicker } from './role-picker.tsx';
import type { SendInvite } from './use-org-access.ts';

/** The one Invite wizard on Members: roles, and Developer access when the plan and Polaris ID allow. Org admins see no group names. */
export function MemberInviteWizard({
  open,
  onOpenChange,
  onInvite,
  developers = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvite: SendInvite;
  developers?: boolean;
}) {
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [developer, setDeveloper] = useState(false);
  // Developer access alone is an invitation: roles are only needed to join the org as well.
  const valid =
    roles.length > 0 ? InviteOrgMemberSchema.shape.roles.safeParse(roles).success : developer;
  const summary = [
    ...roles.map((r) => ROLE_LABELS[r]),
    ...(developer ? ['Developer access'] : []),
  ].join(', ');

  return (
    <InviteWizard
      open={open}
      onOpenChange={onOpenChange}
      title="Invite member"
      onClose={() => {
        setRoles([]);
        setDeveloper(false);
      }}
      send={(email) => onInvite({ email, roles, ...(developer ? { developer } : {}) })}
      access={{
        title: 'Access',
        heading: 'Choose access',
        hint: 'Pick a role.',
        error: valid ? undefined : 'Choose at least one role.',
        summary: summary || undefined,
        dirty: roles.length > 0 || developer,
        review: [
          {
            label: 'Roles',
            value: roles.length ? roles.map((r) => ROLE_LABELS[r]).join(', ') : 'None',
          },
          ...(developers ? [{ label: 'Developer access', value: developer ? 'Yes' : 'No' }] : []),
        ],
        node: (errors) => (
          <div className="flex flex-col gap-4">
            <RolePicker
              roles={roles}
              onChange={setRoles}
              error={errors.access}
              idPrefix="invite-role"
            />
            {developers ? (
              <CheckboxField
                label="Developer access"
                checked={developer}
                onCheckedChange={(on) => setDeveloper(on === true)}
              />
            ) : null}
          </div>
        ),
      }}
    />
  );
}
