import { useMutation } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { OkSchema } from '@/shared/contracts/common.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/errors.ts';
import { safeNext } from '../lib/redirect.ts';
import { useSession } from '../lib/session.ts';
import {
  Button,
  Card,
  CardBody,
  ErrorState,
  FormField,
  Input,
  PageHeader,
  Skeleton,
} from '../ui/index.ts';
import { goTo } from './goto.ts';
import { loginErrorMessage } from './login-errors.ts';
import { Turnstile } from './turnstile.tsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function CodeStep({ email, next, onBack }: { email: string; next: string; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const consume = useMutation({
    mutationFn: () => api.action('POST', '/auth/magic/consume', { email, code }),
    onSuccess: () => goTo(next),
    onError: (e) => setError(errorMessage(e)),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code.');
    consume.mutate();
  }
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-fg-strong">Check your email</h2>
      <p className="text-sm text-fg-muted">
        If {email} is known, we sent a sign-in link and code. Open the link or enter the code here.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <FormField label="6-digit code" error={error}>
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          )}
        </FormField>
        <Button type="submit" loading={consume.isPending}>
          Sign in
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Use a different email
        </Button>
      </form>
    </div>
  );
}

function MagicForm({ siteKey, next }: { siteKey: string; next: string }) {
  const [email, setEmail] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [error, setError] = useState<string>();
  const [challengeError, setChallengeError] = useState<string>();
  const [sentTo, setSentTo] = useState<string>();

  const request = useMutation({
    mutationFn: (vars: { email: string; turnstileToken: string }) =>
      api.post('/auth/magic/request', OkSchema, { ...vars, next }),
    onSuccess: (_res, vars) => setSentTo(vars.email),
    onError: (e) => {
      setError(errorMessage(e));
      setToken(null);
      setResetKey((k) => k + 1);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const value = email.trim();
    if (!EMAIL_RE.test(value)) return setError('Enter a valid email.');
    if (!token) return setError('Complete the check first.');
    request.mutate({ email: value, turnstileToken: token });
  }

  if (sentTo) {
    return (
      <CodeStep
        email={sentTo}
        next={next}
        onBack={() => {
          setSentTo(undefined);
          setToken(null);
          setResetKey((k) => k + 1);
        }}
      />
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <FormField label="Email" error={error}>
        {(control) => (
          <Input
            {...control}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
      </FormField>
      <Turnstile
        siteKey={siteKey}
        resetKey={resetKey}
        onToken={setToken}
        onError={() => setChallengeError('The check failed to load. Reload the page.')}
      />
      {challengeError ? (
        <p role="alert" className="text-xs text-danger">
          {challengeError}
        </p>
      ) : null}
      <Button type="submit" variant="outline" loading={request.isPending}>
        Email me a sign-in link
      </Button>
    </form>
  );
}

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

  useEffect(() => {
    if (authedAlready) goTo(next);
  }, [authedAlready, next]);

  const message = loginErrorMessage(error);
  let body: ReactNode;
  if (isPending || authedAlready) {
    body = <Skeleton className="h-40" />;
  } else if (isError || !session) {
    body = <ErrorState error={loadError} onRetry={() => void refetch()} />;
  } else if (session.authenticated) {
    body = null;
  } else if (!session.oidcEnabled && !session.magicLinkEnabled) {
    body = <p className="text-sm text-fg-muted">Sign-in is unavailable.</p>;
  } else {
    body = (
      <div className="flex flex-col gap-5">
        {session.oidcEnabled ? (
          <Button asChild size="lg">
            <a href={`/auth/oidc/start?next=${encodeURIComponent(next)}`}>
              Sign in with Polaris ID
            </a>
          </Button>
        ) : null}
        {session.oidcEnabled && session.magicLinkEnabled ? (
          <div className="flex items-center gap-3 text-xs text-fg-subtle" aria-hidden>
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
        ) : null}
        {session.magicLinkEnabled ? (
          <MagicForm siteKey={session.turnstileSiteKey} next={next} />
        ) : null}
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Sign in" />
      {message ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-fg-strong"
        >
          {message}
        </p>
      ) : null}
      <Card>
        <CardBody>{body}</CardBody>
      </Card>
    </>
  );
}
