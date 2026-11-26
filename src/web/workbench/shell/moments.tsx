import { KeyRound } from 'lucide-react';
import { POLARIS_ID_COPY } from '@/shared/copy/sign-in.ts';
import { WB_STATES } from '@/shared/copy/workbench-states.ts';
import { Buddy } from '../../ui/art/index.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';

// Shell pieces only some sessions see, in their own chunk (WB_SHELL_BUDGET).

/** Signed out, at the sidebar's foot: the buddy waves over one line and Sign in. */
export function SignInCard({ next }: { next: string }) {
  return (
    <div className="relative mx-3 mt-16 mb-3 rounded-lg border border-dashed border-border-strong bg-surface-page px-3.5 pt-3 pb-3.5">
      <div aria-hidden className="absolute -top-px right-4 h-0 w-16">
        <Buddy size="sm" scene="wave" mood="happy" state="login" at="end" />
      </div>
      <p className="mb-2.5 text-sm font-medium text-fg-strong">{WB_STATES.signedOut.title}</p>
      <Button asChild size="sm" iconStart={<KeyRound aria-hidden />} className="w-full">
        <a href={`/auth/oidc/start?next=${encodeURIComponent(next)}`}>{POLARIS_ID_COPY.signIn}</a>
      </Button>
    </div>
  );
}

/** The session behind the token ended: one banner, the page kept, back to this URL after. */
export function SessionGoneBanner() {
  const here = `${location.pathname}${location.search}${location.hash}`;
  return (
    <Callout
      tone="warning"
      title={WB_STATES.sessionExpired.title}
      actionsAside
      className="mb-4"
      actions={
        <Button asChild variant="outline" size="sm">
          <a href={`/login?next=${encodeURIComponent(here)}&reason=expired`}>
            {WB_STATES.sessionExpired.action}
          </a>
        </Button>
      }
    />
  );
}
