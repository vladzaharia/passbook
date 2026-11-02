import { RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { errorMessage } from '../lib/errors.ts';
import { safeNext } from '../lib/redirect.ts';
import { useSession } from '../lib/session.ts';
import { Button, Callout } from '../ui/index.ts';
import { Wordmark } from '../ui/layout/wordmark.tsx';
import { goTo } from './goto.ts';
import { LoginCard } from './login-card.tsx';
import { loginErrorMessage } from './login-errors.ts';
import { LoginScene, useLoginScene } from './login-scene.tsx';

/**
 * The hosted sign-in page: wordmark, the wallet scene on the card's top edge, then the card.
 * The worker's SSR auth pages (src/worker/ssr/hosted.ts) mirror these metrics exactly.
 */
export function LoginPage({
  next: rawNext,
  error,
}: {
  next?: string | undefined;
  error?: string | undefined;
}) {
  const { session, isPending, isError, error: loadError, refetch } = useSession();
  const next = safeNext(rawNext);
  const authedAlready = session?.authenticated === true;
  const [scene, sceneActions] = useLoginScene();

  useEffect(() => {
    if (authedAlready) goTo(next);
  }, [authedAlready, next]);
  useEffect(() => {
    document.title = 'Sign in · Wallet';
  }, []);

  let front: ReactNode;
  let methods: { oidc: boolean; magic: boolean; siteKey: string } | null = null;
  if (isPending || authedAlready) {
    front = undefined;
  } else if (isError || !session) {
    front = (
      <Callout
        tone="danger"
        actions={
          <Button
            variant="outline"
            iconStart={<RefreshCw aria-hidden />}
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        }
      >
        {errorMessage(loadError)}
      </Callout>
    );
  } else if (!session.authenticated) {
    if (!session.oidcEnabled && !session.magicLinkEnabled) {
      front = <p className="text-sm text-fg-muted">Sign-in is unavailable.</p>;
    } else {
      methods = {
        oidc: session.oidcEnabled,
        magic: session.magicLinkEnabled,
        siteKey: session.turnstileSiteKey,
      };
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col items-center pt-8 pb-10 sm:pt-14">
      <div className="flex h-11 items-center justify-center">
        <Wordmark flip={false} />
      </div>
      <LoginScene state={scene} className="relative z-0 mt-4 -mb-3.5 sm:-mb-4" />
      <div className="relative z-10 w-full">
        <LoginCard
          next={next}
          notice={loginErrorMessage(error)}
          methods={methods}
          front={front}
          scene={sceneActions}
        />
      </div>
    </div>
  );
}
