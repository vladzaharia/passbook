import { useMutation } from '@tanstack/react-query';
import { CircleAlert, Mail } from 'lucide-react';
import { type FormEvent, type Ref, useId, useState } from 'react';
import { MagicConsumeResultSchema } from '@/shared/contracts/session.ts';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { WRONG_CODE } from '@/shared/copy/sign-in.ts';
import { api } from '../lib/api.ts';
import { isApiError } from '../lib/errors.ts';
import { safeNext } from '../lib/redirect.ts';
import { CODE_LENGTH, CodeField } from '../ui/code-field.tsx';
import { lockoutLine } from '../ui/identity-card.tsx';
import { Button, Callout, Label, useNow } from '../ui/index.ts';
import { goTo } from './goto.ts';
import { type SignInError, signInError } from './login-errors.ts';
import { failure, type SceneActions } from './login-scene.tsx';
import { CHALLENGE_FAILED, type MagicRequest } from './use-magic-request.ts';

/** Matches the server's magic-link lifetime (auth MAGIC_TTL_MS, "Expires in 15 minutes"). */
export const CODE_TTL_MS = 15 * 60_000;
export const RESEND_COOLDOWN_MS = 30_000;

export interface CodeFaceProps {
  email: string;
  sentAt: number;
  request: MagicRequest;
  scene: SceneActions;
  codeRef: Ref<HTMLInputElement>;
  onBack: () => void;
}

/** Back face: the 6-digit code from the email, resend with a cooldown, or a different email. */
export function CodeFace({ email, sentAt, request, scene, codeRef, onBack }: CodeFaceProps) {
  const id = useId();
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<SignInError>();
  const [cooldownUntil, setCooldownUntil] = useState(sentAt + RESEND_COOLDOWN_MS);
  const [resent, setResent] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const now = useNow(1000, Boolean(email));
  const left = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const locked = lockedUntil > now;

  const consume = useMutation({
    mutationFn: () => api.post('/auth/magic/consume', MagicConsumeResultSchema, { email, code }),
    // The server applies the landing rule to the next it stored with the request.
    onSuccess: (result) => {
      scene.succeed();
      goTo(safeNext(result.next));
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 400) {
        setFieldError(WRONG_CODE);
        scene.fail(Date.now() - sentAt > CODE_TTL_MS ? 'expired' : 'slip');
        return;
      }
      if (isApiError(e) && e.status === 429 && e.retryAfter !== undefined) {
        setLockedUntil(Date.now() + e.retryAfter * 1000);
        setCode('');
        scene.fail('error');
        return;
      }
      setError(signInError(e));
      scene.fail(failure(e));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setFieldError(undefined);
    setError(undefined);
    if (code.length !== CODE_LENGTH) return setFieldError('Enter the 6-digit code.');
    consume.mutate();
  }

  async function resend() {
    setError(undefined);
    const result = await request.send(email);
    if (result.ok) {
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
      setResent((n) => n + 1);
      setCode('');
      setFieldError(undefined);
      return;
    }
    if ('challenge' in result) {
      scene.fail('error');
      return setError({ message: CHALLENGE_FAILED });
    }
    setError(signInError(result.error));
    scene.fail(failure(result.error));
  }

  const noteId = `${id}-note`;
  const resendLabel =
    request.phase === 'checking'
      ? 'Checking…'
      : left > 0
        ? `${HOLDER_COPY.sendAgain} in ${left}s`
        : HOLDER_COPY.sendAgain;
  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <Callout tone="danger" title={error.title}>
          {error.message}
        </Callout>
      ) : null}
      {locked ? (
        <p role="status" className="text-sm text-fg-muted">
          Too many tries. {lockoutLine(lockedUntil, now)}
        </p>
      ) : null}
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <fieldset
          disabled={locked}
          className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0 disabled:opacity-50"
        >
          <div className="flex flex-col">
            <Label htmlFor={id} className="mb-2">
              Or enter the 6-digit code
            </Label>
            <CodeField
              id={id}
              value={code}
              onChange={(v) => {
                setCode(v);
                setFieldError(undefined);
                // The eyes follow the slot the next digit goes in.
                const slots = document
                  .getElementById(id)
                  ?.parentElement?.querySelectorAll('.wl-code-slot');
                const slot = slots?.[Math.min(v.length, CODE_LENGTH - 1)]?.getBoundingClientRect();
                if (slot) scene.gaze(slot.left + slot.width / 2);
              }}
              onBlur={() => scene.gaze(null)}
              inputRef={codeRef}
              invalid={Boolean(fieldError)}
              describedBy={fieldError ? noteId : undefined}
            />
            {fieldError ? (
              <p id={noteId} className="mt-1 flex items-start gap-1.5 text-xs text-danger">
                <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                {fieldError}
              </p>
            ) : null}
          </div>
          <Button type="submit" className="w-full" loading={consume.isPending}>
            Sign in
          </Button>
        </fieldset>
        {/* Ghost labels line up with the card text; on a phone the pair stacks. */}
        <div className="-mx-3 flex flex-wrap items-center justify-between gap-x-2">
          <Button
            variant="ghost"
            className="px-3 disabled:text-fg-muted disabled:opacity-100"
            disabled={left > 0 || request.phase !== 'idle'}
            loading={request.phase !== 'idle'}
            // The envelope flies once the new code is on its way; the countdown says it went.
            done={resent || undefined}
            iconStart={<Mail aria-hidden />}
            onClick={() => void resend()}
          >
            {resendLabel}
          </Button>
          <Button variant="ghost" className="px-3" onClick={onBack}>
            Use a different email
          </Button>
        </div>
      </form>
    </div>
  );
}
