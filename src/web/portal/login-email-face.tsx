import { ArrowRight } from 'lucide-react';
import { type FormEvent, type Ref, useEffect, useState } from 'react';
import { INVALID_EMAIL } from '@/shared/copy/sign-in.ts';
import { strictEmail } from '@/shared/email.ts';
import { isApiError } from '../lib/errors.ts';
import { Button, Callout, FormField, Input } from '../ui/index.ts';
import { type SignInError, signInError } from './login-errors.ts';
import type { SceneActions } from './login-scene.tsx';
import { CHALLENGE_FAILED, type MagicRequest } from './use-magic-request.ts';

const isEmail = (value: string) => strictEmail(value) !== null;

/**
 * Installed to the home screen: a link in the email opens Safari, not this app, so the code
 * leads.
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true
  );
}
/** An average address character at the field's 16 px, and the field's side padding. */
const CHAR_PX = 8.3;
const PAD_PX = 12;

/** About where the caret is after `chars` characters: the eyes follow it. */
function caretX(field: HTMLInputElement, chars: number): number {
  const box = field.getBoundingClientRect();
  return Math.min(box.right - PAD_PX, box.left + PAD_PX + chars * CHAR_PX);
}

export interface EmailFaceProps {
  oidc: boolean;
  magic: boolean;
  next: string | null;
  /** One line from ?reason=, shown until something goes wrong. */
  notice: string | null;
  request: MagicRequest;
  scene: SceneActions;
  emailRef: Ref<HTMLInputElement>;
  onSent: (email: string) => void;
}

/** Polaris ID, outline; a foil sweep runs along its border on fine-pointer hover. */
function PolarisButton({ next, primary }: { next: string | null; primary: boolean }) {
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
  const [error, setError] = useState<SignInError>();
  const [standalone] = useState(isStandalone);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFieldError(undefined);
    setError(undefined);
    const value = email.trim();
    if (!isEmail(value)) return setFieldError(INVALID_EMAIL);
    const result = await request.send(value);
    if (result.ok) return onSent(value);
    if ('challenge' in result) {
      scene.fail({ shake: false });
      return setError({ message: CHALLENGE_FAILED });
    }
    if (isApiError(result.error) && result.error.status === 422) {
      scene.fail({ shake: false });
      return setFieldError(INVALID_EMAIL);
    }
    setError(signInError(result.error));
    scene.fail({ shake: isApiError(result.error) && result.error.status === 429 });
  }

  const { challengeFailed } = request;
  useEffect(() => {
    if (challengeFailed) scene.fail({ shake: false });
  }, [challengeFailed, scene]);

  const callout = error ?? (request.challengeFailed ? { message: CHALLENGE_FAILED } : null);
  const busy = request.phase !== 'idle';
  return (
    <div className="flex flex-col gap-6">
      {callout ? (
        <Callout tone="danger" title={callout.title}>
          {callout.message}
        </Callout>
      ) : notice ? (
        <Callout>{notice}</Callout>
      ) : null}
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
            className="w-full"
            loading={busy}
            iconEnd={busy ? null : <ArrowRight aria-hidden />}
          >
            {request.phase === 'checking'
              ? 'Checking…'
              : standalone
                ? 'Email me a code'
                : 'Email me a sign-in link'}
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
