import { LogOut } from 'lucide-react';
import { signOut, useSession } from '../lib/session.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EntityAvatar,
  KeyValue,
  PageHeader,
} from '../ui/index.ts';
import { EmailsSection } from './account-emails.tsx';
import { SessionsSection } from './account-sessions.tsx';
import './portal.css';

const METHOD = { oidc: 'Polaris ID', magic_link: 'Email link', breakglass: 'Break-glass' } as const;

export function AccountPage({ focusAdd = false }: { focusAdd?: boolean }) {
  const { authed } = useSession();
  const doSignOut = () => void signOut(authed?.csrfToken);
  return (
    <>
      <PageHeader
        size="lg"
        title="Account"
        actions={
          <Button variant="outline" iconStart={<LogOut aria-hidden />} onClick={doSignOut}>
            Sign out
          </Button>
        }
      />
      <div className="flex max-w-3xl flex-col gap-6">
        {authed ? (
          <Card>
            <CardHeader title="Profile" />
            <CardBody className="flex flex-col gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <EntityAvatar
                  kind="user"
                  id={authed.user.id}
                  name={authed.user.name ?? authed.user.primaryEmail}
                  size={48}
                />
                <div className="min-w-0">
                  {authed.user.name ? (
                    <p className="truncate text-base font-semibold text-fg-strong">
                      {authed.user.name}
                    </p>
                  ) : null}
                  <p className="truncate text-sm text-fg-muted">{authed.user.primaryEmail}</p>
                </div>
              </div>
              <KeyValue items={[{ label: 'Signed in with', value: METHOD[authed.amr] }]} />
            </CardBody>
          </Card>
        ) : null}
        <EmailsSection focusAdd={focusAdd} />
        <SessionsSection onSignedOutEverywhere={doSignOut} />
      </div>
    </>
  );
}
