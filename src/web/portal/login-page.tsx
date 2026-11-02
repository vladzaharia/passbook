import { RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { errorMessage } from '../lib/errors.ts';
import { safeNext } from '../lib/redirect.ts';
import { clearSignedOut, signedOutJustNow, useSession } from '../lib/session.ts';
import { Button, Callout } from '../ui/index.ts';
import { Wordmark } from '../ui/layout/wordmark.tsx';
import { goTo } from './goto.ts';
import { LoginCard } from './login-card.tsx';
import { loginErrorMessage } from './login-errors.ts';
import { LoginScene, useLoginScene } from './login-scene.tsx';

// Read once per page load (a remount while the session loads still waves); cleared after mount.
let bye: boolean | undefined;

/**
 * The hosted sign-in page: one header band (the wordmark left, the wallet seated on the card's top
 * edge at the right), then the card. The worker's SSR auth pages (src/worker/ssr/hosted.ts)
 * mirror these metrics exactly.
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
  const [scene, sceneActions] = useLoginScene(Boolean(error));
  bye ??= signedOutJustNow();
  useEffect(clearSignedOut, []);

  useEffect(() => {
    if (authedAlready) goTo(next);
  }, [authedAlready, next]);
  useEffect(() => {
    document.title = 'Sign in · PassBook';
  }, []);

  let front: ReactNode;
  let failed = false;
  let methods: { oidc: boolean; magic: boolean; siteKey: string } | null = null;
  if (isPending || authedAlready) {
    front = undefined;
  } else if (isError || !session) {
    failed = true;
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
      failed = true;
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
    <div className="mx-auto flex w-full max-w-sm flex-col pt-8 pb-10 sm:pt-14">
      <div className="wl-login-band">
        <div className="wl-login-brand">
          <Wordmark flip={false} size="lg" />
        </div>
        <LoginScene state={scene} sad={failed} bye={bye} />
      </div>
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
