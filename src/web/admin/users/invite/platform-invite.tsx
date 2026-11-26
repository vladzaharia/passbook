import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { GroupListSchema } from '@/shared/contracts/idp-access.ts';
import {
  PLATFORM_INVITATION_MAX_GROUPS,
  PlatformInvitationCreatedSchema,
} from '@/shared/contracts/platform-invitations.ts';
import { IDP_COPY } from '@/shared/copy/idp.ts';
import { api } from '@/web/lib/api.ts';
import { CheckboxField, EmptyState, SkeletonRows } from '@/web/ui/index.ts';
import { InviteWizard } from './invite-wizard.tsx';

/** Platform invitations carry Polaris ID groups (custom or adopted), and optionally developer access. */
export function PlatformInviteWizard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [keys, setKeys] = useState<string[]>([]);
  const [developer, setDeveloper] = useState(false);
  const groups = useQuery({
    queryKey: ['idp', 'invite-groups'],
    enabled: open,
    retry: false,
    queryFn: async ({ signal }) =>
      (await api.get('/api/v1/platform/idp/groups', GroupListSchema, { signal })).items.filter(
        (g) => g.kind !== 'role' && g.flags.length === 0,
      ),
  });
  const choices = groups.data ?? [];
  const named = keys.map((k) => choices.find((g) => g.key === k)?.friendlyName ?? k);
  const error =
    keys.length === 0 && !developer
      ? 'Choose a group or developer access.'
      : keys.length > PLATFORM_INVITATION_MAX_GROUPS
        ? `Choose at most ${PLATFORM_INVITATION_MAX_GROUPS} groups.`
        : undefined;
  const toggle = (key: string, on: boolean) =>
    setKeys((now) => (on ? [...now, key] : now.filter((k) => k !== key)));
  const summary = [...named, ...(developer ? ['Developer'] : [])].join(', ');

  return (
    <InviteWizard
      open={open}
      onOpenChange={onOpenChange}
      title="Invite to Polaris ID"
      onClose={() => {
        setKeys([]);
        setDeveloper(false);
      }}
      send={async (email) => {
        const made = await api.post(
          '/api/v1/platform/invitations',
          PlatformInvitationCreatedSchema,
          {
            email,
            groups: keys,
            developer,
          },
        );
        return { link: made.link };
      }}
      access={{
        title: 'Groups',
        heading: 'Choose groups',
        hint: 'Pick a group.',
        error,
        summary: summary || undefined,
        dirty: keys.length > 0 || developer,
        review: [
          { label: 'Groups', value: named.length ? named.join(', ') : 'None' },
          { label: 'Developer access', value: developer ? 'Yes' : 'No' },
        ],
        node: (errors) => (
          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">Groups</legend>
            {groups.isPending ? (
              <SkeletonRows rows={3} label="Loading groups" />
            ) : choices.length === 0 ? (
              <EmptyState inline art="people" title={IDP_COPY.noGroups} />
            ) : (
              choices.map((g) => (
                <CheckboxField
                  key={g.key}
                  label={g.friendlyName ?? g.name}
                  checked={keys.includes(g.key)}
                  onCheckedChange={(on) => toggle(g.key, on === true)}
                />
              ))
            )}
            <CheckboxField
              className="mt-1 border-t border-border pt-3"
              label="Developer access"
              checked={developer}
              onCheckedChange={(on) => setDeveloper(on === true)}
            />
            {errors.access ? <p className="text-xs text-danger">{errors.access}</p> : null}
          </fieldset>
        ),
      }}
    />
  );
}
