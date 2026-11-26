import { useEffect } from 'react';
import { INVITATION_COPY as copy } from '@/shared/copy/invitation.ts';
import { TURNSTILE_INVITE_ACTION } from '@/shared/turnstile.ts';
import { Turnstile } from '../portal/turnstile.tsx';
import { Button, Callout, Skeleton } from '../ui/index.ts';
import { Wordmark } from '../ui/layout/wordmark.tsx';
import { SIGN_IN_HREF, useInvite } from './use-invite.ts';

/**
 * The one invitation page, for member and developer invitations. It reads the secret from the fragment, names the
 * invitation, and then either accepts (a strong Polaris ID session) or offers the paths to one: create a Polaris ID
 * (a one-hour signup carrying the invitation's groups), or sign in with the account that already has the address.
 */
export function InvitePage() {
  const invite = useInvite();
  const { view } = invite;
  const preview = 'preview' in view ? view.preview : null;
  useEffect(() => {
    document.title = preview
      ? `${copy.title(preview.kind, preview.orgName)} · PassBook`
      : 'Invitation · PassBook';
  }, [preview]);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4 pt-8 pb-10 sm:pt-14">
      <div className="px-1">
        <Wordmark hello={false} size="lg" />
      </div>
      <section className="wl-foil-edge flex flex-col overflow-hidden rounded-xl border border-border bg-surface-raised shadow-elevation-1">
        <div className="flex flex-col gap-6 p-5 sm:p-6" aria-busy={view.kind === 'loading'}>
          {view.kind === 'loading' ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-8 w-3/4" />
              <Skeleton className="h-5" />
              <Skeleton className="h-9 pointer-coarse:h-11" />
            </div>
          ) : view.kind === 'invalid' ? (
            <h1 className="text-2xl font-semibold tracking-[-0.015em] text-fg-strong">
              {copy.invalid}
            </h1>
          ) : (
            <Body invite={invite} />
          )}
        </div>
      </section>
      {invite.siteKey ? (
        <div className="h-0 overflow-hidden">
          <Turnstile siteKey={invite.siteKey} action={TURNSTILE_INVITE_ACTION} {...invite.widget} />
        </div>
      ) : null}
    </div>
  );
}

function Body({ invite }: { invite: ReturnType<typeof useInvite> }) {
  const { view } = invite;
  if (view.kind === 'loading' || view.kind === 'invalid') return null;
  const { preview } = view;
  const joined = view.kind === 'joined';
  const title = joined
    ? copy.joined(preview.kind, preview.orgName)
    : copy.title(preview.kind, preview.orgName);
  const lede = joined ? null : copy.lede(preview.kind, preview.roles);
  return (
    <>
      <div>
        <h1 className="break-words text-2xl font-semibold tracking-[-0.015em] text-fg-strong">
          {title}
        </h1>
        {lede ? <p className="mt-1 break-words text-sm text-fg-muted">{lede}</p> : null}
        {joined ? null : (
          <p className="mt-1 break-words text-sm text-fg-muted">{copy.address(preview.email)}</p>
        )}
      </div>
      {invite.error ? <Callout tone="danger">{invite.error}</Callout> : null}
      {view.kind === 'accepting' ? (
        <p role="status" className="text-sm text-fg-muted">
          {copy.accepting}
        </p>
      ) : view.kind === 'joined' ? (
        <Button asChild>
          <a
            href={
              preview.kind === 'developer' && !view.accepted.membership ? '/developers' : '/admin'
            }
          >
            {preview.kind === 'developer' && !view.accepted.membership
              ? copy.openDevelopers
              : copy.openAdmin}
          </a>
        </Button>
      ) : view.kind === 'made' ? (
        <>
          <p role="status" className="text-sm text-fg-muted">
            {copy.afterSetup}
          </p>
          <Button asChild>
            <a href={SIGN_IN_HREF}>{copy.signIn}</a>
          </Button>
        </>
      ) : (
        <Choices
          invite={invite}
          polaris={preview.polaris}
          weak={view.weak}
          canAccept={view.canAccept}
          orgName={preview.orgName}
        />
      )}
    </>
  );
}

function Choices({
  invite,
  polaris,
  weak,
  canAccept,
  orgName,
}: {
  invite: ReturnType<typeof useInvite>;
  polaris: boolean;
  weak: boolean;
  canAccept: boolean;
  orgName: string | null;
}) {
  // Already signed in (by email link, or as someone else): signing in again leads. A stranger starts with an account.
  const signIn = (
    <Button asChild variant={weak || !polaris ? 'primary' : 'outline'}>
      <a href={SIGN_IN_HREF}>{copy.signIn}</a>
    </Button>
  );
  if (canAccept)
    return (
      <div className="flex flex-col gap-3">
        <Button onClick={() => void invite.accept()}>{copy.accept}</Button>
        <Button asChild variant="outline">
          <a href={SIGN_IN_HREF}>{copy.otherAccount}</a>
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      {weak ? (
        <p role="status" className="text-sm text-fg-muted">
          {copy.signInLine.replace('{org}', orgName ?? 'PassBook')}
        </p>
      ) : null}
      {weak ? signIn : null}
      {polaris ? (
        <Button
          variant={weak ? 'outline' : 'primary'}
          loading={invite.working === 'create'}
          disabled={invite.working !== null}
          onClick={() => void invite.create()}
        >
          {copy.create}
        </Button>
      ) : null}
      {weak ? null : signIn}
      {polaris ? (
        <Button
          variant="outline"
          loading={invite.working === 'have'}
          disabled={invite.working !== null}
          onClick={() => void invite.have()}
        >
          {copy.have}
        </Button>
      ) : null}
    </div>
  );
}
