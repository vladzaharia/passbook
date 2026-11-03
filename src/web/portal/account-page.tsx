import { useEffect, useRef } from 'react';
import { useSession } from '../lib/session.ts';
import { signInMethodLabel } from '../lib/status.ts';
import {
  Card,
  CardBody,
  CardHeader,
  EntityAvatar,
  KeyValue,
  PageHeader,
  toast,
} from '../ui/index.ts';
import { EmailsSection } from './account-emails.tsx';
import { SessionsSection } from './account-sessions.tsx';
import './portal.css';

export interface AccountPageProps {
  /** ?add=email (from the empty My passes): focus the add-email row. */
  focusAdd?: boolean;
  /** ?verified=<email>: the add-email link just confirmed it. */
  verified?: string;
  /** Drops ?verified= from the URL once the toast is up (a reload must not repeat it). */
  onVerifiedShown?: () => void;
}

/**
 * One Account page for the person, in whichever shell it is opened from (portal /account, console
 * /admin/account). Signing out lives in the account menu; ending every session, on Sessions.
 */
export function AccountPage({ focusAdd = false, verified, onVerifiedShown }: AccountPageProps) {
  const { authed } = useSession();
  const confirmed = useRef(false);
  useEffect(() => {
    if (!verified || confirmed.current) return;
    confirmed.current = true;
    toast.success('Email added');
    onVerifiedShown?.();
  }, [verified, onVerifiedShown]);
  return (
    <div className="max-w-3xl">
      <PageHeader title="Account" />
      <div className="flex flex-col gap-6">
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
              <KeyValue
                items={[{ label: 'Signed in with', value: signInMethodLabel(authed.amr) }]}
              />
            </CardBody>
          </Card>
        ) : null}
        <EmailsSection focusAdd={focusAdd} />
        <SessionsSection />
      </div>
    </div>
  );
}
