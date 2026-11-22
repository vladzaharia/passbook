import { useNavigate } from '@tanstack/react-router';
import { KeyRound, Mail } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { NO_EMAIL_LABEL } from '../../shared/email.ts';
import { personLabel } from '../lib/format.ts';
import { useSession } from '../lib/session.ts';
import { signInMethodLabel } from '../lib/status.ts';
import { Badge, Card, CardBody, EntityAvatar, PageHeader, toast } from '../ui/index.ts';
import { EmailsSection } from './account-emails.tsx';
import { SessionsSection } from './account-sessions.tsx';
import './portal.css';

export interface AccountPageProps {
  /** ?add=email (from the empty My passes): focus the add-email row. */
  focusAdd?: boolean;
  /** ?verified=<email>: the add-email link just confirmed it. */
  verified?: string;
}

/**
 * One Account page for the person, in whichever shell it is opened from (portal /account, console
 * /admin/account). Signing out lives in the account menu; ending every session, on Sessions.
 */
export function AccountPage({ focusAdd = false, verified }: AccountPageProps) {
  const navigate = useNavigate();
  const { authed } = useSession();
  const confirmed = useRef(false);
  useEffect(() => {
    if (!verified || confirmed.current) return;
    confirmed.current = true;
    toast.success('Email added');
    // The address leaves the URL at once: a reload must not repeat the toast.
    void navigate({ to: '.', search: (s) => ({ ...s, verified: undefined }), replace: true });
  }, [verified, navigate]);
  const Method = authed?.amr === 'oidc' ? KeyRound : Mail;
  return (
    <div className="max-w-3xl">
      <PageHeader title="Account" />
      <div className="flex min-w-0 flex-col gap-6">
        {authed ? (
          <Card>
            <CardBody className="flex items-center gap-3">
              <EntityAvatar
                kind="user"
                id={authed.user.id}
                name={personLabel(authed.user)}
                size={48}
              />
              <div className="min-w-0 flex-1">
                {authed.user.name ? (
                  <p className="truncate text-sm font-semibold text-fg-strong">
                    {authed.user.name}
                  </p>
                ) : null}
                <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
                  {authed.user.primaryEmail ?? NO_EMAIL_LABEL}
                </p>
              </div>
              <Badge tone="neutral" className="shrink-0">
                <Method aria-hidden />
                {signInMethodLabel(authed.amr)}
              </Badge>
            </CardBody>
          </Card>
        ) : null}
        <EmailsSection focusAdd={focusAdd} userId={authed?.user.id} />
        <SessionsSection />
      </div>
    </div>
  );
}
