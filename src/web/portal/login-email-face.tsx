import { ArrowRight } from 'lucide-react';
import { type FormEvent, type Ref, useState } from 'react';
import { LOGIN_OPERATOR_COPY } from '@/shared/copy/login-reasons.ts';
import { INVALID_EMAIL } from '@/shared/copy/sign-in.ts';
import { strictEmail } from '@/shared/email.ts';
import { isApiError } from '../lib/errors.ts';
import { caretX } from '../lib/gaze.ts';
import { Button, Callout, FormField, Input, useNow } from '../ui/index.ts';
import { isStandalone } from './device.ts';
import { type SignInError, signInError } from './login-errors.ts';
import { failure, type SceneActions } from './login-scene.tsx';
import { CHALLENGE_FAILED, type MagicRequest } from './use-magic-request.ts';

/** A rate limit's wait when the server gives none (the copy says "a minute"). */
const RATE_WAIT_MS = 60_000;

const isEmail = (value: string) => strictEmail(value) !== null;

export interface EmailFaceProps {
  oidc: boolean;
  magic: boolean;
  next: string | null;
  /** One line from ?reason=, shown until something goes wrong. */
  notice: string | null;
  /** Admin or Developers is next: the account button leads, email sits under it for pass holders. */
  operator?: boolean;
  request: MagicRequest;
  scene: SceneActions;
  emailRef: Ref<HTMLInputElement>;
  onSent: (email: string) => void;
}

/** The identity provider, outline; a foil sweep runs along its border on fine-pointer hover. */
function AccountButton({ next, primary }: { next: string | null; primary: boolean }) {
  const href = next ? `/auth/oidc/start?next=${encodeURIComponent(next)}` : '/auth/oidc/start';
  return (
    <Button asChild variant={primary ? 'primary' : 'outline'} className="wl-sweep w-full">
      <a href={href}>
        <span aria-hidden className="wl-sweep-ring" />
        Sign in with Polaris ID
      </a>
    </Button>
  );
}

/** Front face: email first, the account button under "or". */
export function EmailFace({
  oidc,
  magic,
  next,
  notice,
  operator = false,
  request,
  scene,
  emailRef,
  onSent,
}: EmailFaceProps) {
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<SignInError>();
  const [standalone] = useState(isStandalone);
  const [waitUntil, setWaitUntil] = useState(0);
  const now = useNow(1000, waitUntil > 0);
  const waitLeft = Math.max(0, Math.ceil((waitUntil - now) / 1000));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFieldError(undefined);
    setError(undefined);
    const value = email.trim();
    if (!isEmail(value)) {
      scene.fail('slip');
      return setFieldError(INVALID_EMAIL);
    }
    const result = await request.send(value);
    if (result.ok) return onSent(value);
    if ('challenge' in result) {
      scene.fail('error');
      return setError({ message: CHALLENGE_FAILED });
    }
    if (isApiError(result.error) && result.error.status === 422) {
      scene.fail('slip');
      return setFieldError(INVALID_EMAIL);
    }
    if (isApiError(result.error) && result.error.status === 429) {
      setWaitUntil(Date.now() + RATE_WAIT_MS);
    }
    setError(signInError(result.error));
    scene.fail(failure(result.error));
  }

  const callout = error ?? null;
  const busy = request.phase !== 'idle';
  const divider = (
    <div className="flex items-center gap-3 text-xs text-fg-muted" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  );
  const form = magic ? (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <FormField label="Email" error={fieldError}>
        {(control) => (
          <Input
            {...control}
            ref={emailRef}
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus={!operator}
            placeholder="name@example.com"
            value={email}
            onBlur={() => scene.gaze(null)}
            onChange={(e) => {
              setEmail(e.target.value);
              const v = e.target.value.trim();
              const valid = isEmail(v);
              // A shown error goes as soon as the address is valid.
              if (valid) setFieldError(undefined);
              scene.setLetter(valid ? v.charAt(0).toUpperCase() : null);
              scene.gaze(caretX(e.target, e.target.value.length));
            }}
          />
        )}
      </FormField>
      <Button
        type="submit"
        variant={operator ? 'outline' : 'primary'}
        className="w-full"
        loading={busy}
        disabled={waitLeft > 0}
        iconEnd={busy || waitLeft > 0 ? null : <ArrowRight aria-hidden />}
      >
        {request.phase === 'checking'
          ? 'Checking…'
          : waitLeft > 0
            ? `Try again in ${waitLeft}s`
            : standalone
              ? 'Email me a code'
              : 'Email me a sign-in link'}
      </Button>
    </form>
  ) : null;

  return (
    <div className="flex flex-1 flex-col justify-center gap-6">
      {notice ? <Callout>{notice}</Callout> : null}
      {callout ? (
        <Callout tone="danger" title={callout.title}>
          {callout.message}
        </Callout>
      ) : null}
      {operator ? (
        <>
          {oidc ? <AccountButton next={next} primary /> : null}
          {magic && oidc ? divider : null}
          {magic ? (
            <p className="-mb-2 text-center text-sm text-fg-muted">
              {LOGIN_OPERATOR_COPY.holderLine}
            </p>
          ) : null}
          {form}
        </>
      ) : (
        <>
          {form}
          {magic && oidc ? divider : null}
          {oidc ? <AccountButton next={next} primary={!magic} /> : null}
        </>
      )}
    </div>
  );
}
