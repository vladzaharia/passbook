import { ArrowRight } from 'lucide-react';
import { type FormEvent, type Ref, useState } from 'react';
import { errorMessage, isApiError } from '../lib/errors.ts';
import { Button, Callout, FormField, Input } from '../ui/index.ts';
import type { SceneActions } from './login-scene.tsx';
import { CHALLENGE_FAILED, type MagicRequest } from './use-magic-request.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** About how many characters fill the field: the eyes reach its right edge there. */
const GAZE_CHARS = 30;

export interface EmailFaceProps {
  oidc: boolean;
  magic: boolean;
  next: string;
  /** A sentence from an auth redirect (?error=). */
  notice: string | null;
  request: MagicRequest;
  scene: SceneActions;
  emailRef: Ref<HTMLInputElement>;
  onSent: (email: string) => void;
}

/** Polaris ID, outline; a foil sweep runs along its border on fine-pointer hover. */
function PolarisButton({ next, primary }: { next: string; primary: boolean }) {
  return (
    <Button asChild size="lg" variant={primary ? 'primary' : 'outline'} className="wl-sweep w-full">
      <a href={`/auth/oidc/start?next=${encodeURIComponent(next)}`}>
        <span aria-hidden className="wl-sweep-ring" />
        Sign in with Polaris ID
      </a>
    </Button>
  );
}

/** Front face: email first, Polaris ID under "or". */
export function EmailFace({
  oidc,
  magic,
  next,
  notice,
  request,
  scene,
  emailRef,
  onSent,
}: EmailFaceProps) {
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFieldError(undefined);
    setError(undefined);
    const value = email.trim();
    if (!EMAIL_RE.test(value)) return setFieldError('Enter a valid email.');
    const result = await request.send(value);
    if (result.ok) return onSent(value);
    if ('challenge' in result) return setError(CHALLENGE_FAILED);
    setError(errorMessage(result.error));
    if (isApiError(result.error) && result.error.status === 429) scene.fail();
  }

  const callout = error ?? (request.challengeFailed ? CHALLENGE_FAILED : notice);
  const busy = request.phase !== 'idle';
  return (
    <div className="flex flex-col gap-6">
      {callout ? <Callout tone="danger">{callout}</Callout> : null}
      {magic ? (
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
                autoFocus
                value={email}
                className="h-11 text-base"
                onBlur={() => scene.gaze(null)}
                onChange={(e) => {
                  setEmail(e.target.value);
                  const v = e.target.value.trim();
                  const valid = EMAIL_RE.test(v);
                  // A shown error goes as soon as the address is valid.
                  if (valid) setFieldError(undefined);
                  scene.setLetter(valid ? v.charAt(0).toUpperCase() : null);
                  scene.gaze(e.target.value.length / GAZE_CHARS);
                }}
              />
            )}
          </FormField>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            loading={busy}
            iconEnd={busy ? null : <ArrowRight aria-hidden />}
          >
            {request.phase === 'checking' ? 'Checking…' : 'Email me a sign-in link'}
          </Button>
        </form>
      ) : null}
      {magic && oidc ? (
        <div className="flex items-center gap-3 text-xs text-fg-muted" aria-hidden>
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      {oidc ? <PolarisButton next={next} primary={!magic} /> : null}
    </div>
  );
}
