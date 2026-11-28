import { useRouterState } from '@tanstack/react-router';
import { LogIn } from 'lucide-react';
import { AUTH_PAGE_COPY, graceLine } from '@/shared/copy/sign-in.ts';
import { formatDay } from '../../lib/format.ts';
import { useSession } from '../../lib/session.ts';
import { Banner } from '../banner.tsx';
import { Button } from '../button.tsx';

/** One line above the console while an email session still keeps it: Polaris ID is needed by then. */
export function GraceBanner({ now = Date.now() }: { now?: number }) {
  const { authed } = useSession();
  const here = useRouterState({ select: (s) => s.location.href });
  const until = authed?.consoleUntil;
  if (authed?.amr !== 'magic_link' || until == null || now >= until) return null;
  return (
    <Banner
      tone="grace"
      className="mb-4 rounded-lg border"
      action={
        <Button asChild size="sm">
          <a href={`/auth/oidc/start?next=${encodeURIComponent(here)}`}>
            <LogIn aria-hidden />
            {AUTH_PAGE_COPY.signInPolarisId}
          </a>
        </Button>
      }
    >
      {graceLine(formatDay(until))}
    </Banner>
  );
}
