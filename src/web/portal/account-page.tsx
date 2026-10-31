import { LogOut } from 'lucide-react';
import { signOut, useSession } from '../lib/session.ts';
import { Button, Card, CardBody, CardHeader, KeyValue, PageHeader } from '../ui/index.ts';
import { EmailsSection } from './account-emails.tsx';
import { SessionsSection } from './account-sessions.tsx';

export function AccountPage() {
  const { authed } = useSession();
  const doSignOut = () => void signOut(authed?.csrfToken);
  return (
    <>
      <PageHeader
        title="Account"
        actions={
          <Button variant="outline" iconStart={<LogOut aria-hidden />} onClick={doSignOut}>
            Sign out
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        {authed ? (
          <Card>
            <CardHeader title="Profile" />
            <CardBody>
              <KeyValue
                items={[
                  { label: 'Name', value: authed.user.name },
                  {
                    label: 'Signed in with',
                    value: authed.amr === 'oidc' ? 'Polaris ID' : 'Email link',
                  },
                ]}
              />
            </CardBody>
          </Card>
        ) : null}
        <EmailsSection />
        <SessionsSection onSignedOutEverywhere={doSignOut} />
      </div>
    </>
  );
}
