import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';
import { InviteOrgMemberSchema } from '@/shared/contracts/org-membership.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { formatCount } from '@/web/lib/format.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { sessionQuery, useSession } from '@/web/lib/session.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Form,
  FormField,
  Input,
  KeyValue,
  useFormErrors,
} from '@/web/ui/index.ts';
import { type PlatformOrgSummarySchema, useInviteOrgAdmin } from './queries.ts';

type ProvisionedOrg = z.infer<typeof PlatformOrgSummarySchema>;

const PROVISIONING_COUNTS = [
  { key: 'passes', label: 'Passes', singular: 'pass', plural: 'passes', to: '/admin/passes' },
  {
    key: 'templates',
    label: 'Templates',
    singular: 'template',
    plural: 'templates',
    to: '/admin/templates',
  },
  {
    key: 'connections',
    label: 'Connections',
    singular: 'connection',
    plural: 'connections',
    to: '/admin/connections',
  },
  {
    key: 'apiKeys',
    label: 'API keys',
    singular: 'API key',
    plural: 'API keys',
    to: '/admin/api-keys',
  },
] as const;

export function ProvisioningCounts({ org }: { org: ProvisionedOrg }) {
  const mode = useMode();
  // Only a member can open the org's lists; any other scope is Forbidden.
  const { memberships } = useOrgScope();
  const member = memberships.some((m) => m.orgId === org.id);
  const count = (value: number) =>
    `${formatCount(value)}${org.countsCapped && value >= 100_000 ? '+' : ''}`;
  return (
    <Card>
      <CardHeader title="Provisioned resources" />
      <CardBody>
        <p className="mb-3 text-xs text-fg-muted">
          Passes: {mode === 'test' ? 'Test' : 'Live'} mode. Other counts are not mode-filtered. A +
          indicates a lower bound.
        </p>
        <KeyValue
          items={PROVISIONING_COUNTS.map(({ key, label, singular, plural, to }) => {
            const value = org.counts[key];
            const capped = org.countsCapped && value >= 100_000;
            return {
              label,
              value: member ? (
                <Link
                  to={to}
                  search={{ orgId: org.id }}
                  aria-label={`${capped ? 'At least ' : ''}${formatCount(value)} ${value === 1 ? singular : plural} in ${org.name}`}
                  className="text-accent-fg hover:underline"
                >
                  {count(value)}
                </Link>
              ) : (
                count(value)
              ),
            };
          })}
        />
      </CardBody>
    </Card>
  );
}

export function BootstrapOrgAdmin({ orgId, active }: { orgId: string; active: boolean }) {
  const invite = useInviteOrgAdmin(orgId);
  const client = useQueryClient();
  const { authed } = useSession();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const parsed = InviteOrgMemberSchema.safeParse({ email, roles: ['org_admin'] });
  const check = useFormErrors({
    email: parsed.success ? undefined : 'Enter a valid email address.',
  });

  async function submit() {
    if (!active || invite.isPending) return;
    const session = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    if (!session?.authenticated || session.user.id !== authed?.user.id) return;
    const principalId = session.user.id;
    const isCurrentPrincipal = () => {
      const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
      return current?.authenticated === true && current.user.id === principalId;
    };
    setError('');
    setSent(false);
    if (!parsed.success) return;
    try {
      const sent = await invite.mutateAsync({ email: parsed.data.email, principalId });
      if (!sent || !isCurrentPrincipal()) return;
      setEmail('');
      setSent(true);
    } catch (cause) {
      if (isCurrentPrincipal()) setError(errorMessage(cause));
    }
  }

  return (
    <Card>
      <CardHeader title="Platform provisioning: first organization administrator" />
      <CardBody className="flex flex-col gap-4">
        {!active ? (
          <p className="text-sm text-fg-muted">
            Reactivate the organization before inviting an admin.
          </p>
        ) : null}
        <Form {...check.form} onValid={submit} className="flex flex-col gap-3">
          <FormField label="Administrator email" required error={check.errors.email}>
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
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          {sent ? (
            <p role="status" className="text-sm text-fg-muted">
              Administrator invitation sent.
            </p>
          ) : null}
          <div>
            <Button type="submit" size="sm" disabled={!active} loading={invite.isPending}>
              Invite organization admin
            </Button>
          </div>
        </Form>
      </CardBody>
    </Card>
  );
}
