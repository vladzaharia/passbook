import { useMutation } from '@tanstack/react-query';
import { Check, CircleAlert, Mail } from 'lucide-react';
import { type FormEvent, type Ref, useEffect, useId, useState } from 'react';
import { api } from '../lib/api.ts';
import { errorMessage, isApiError } from '../lib/errors.ts';
import { Button, Callout, Label } from '../ui/index.ts';
import { CODE_LENGTH, CodeField } from './code-field.tsx';
import { goTo } from './goto.ts';
import type { SceneActions } from './login-scene.tsx';
import { CHALLENGE_FAILED, type MagicRequest } from './use-magic-request.ts';

/** Matches the server's magic-link lifetime (auth MAGIC_TTL_MS, "Expires in 15 minutes"). */
export const CODE_TTL_MS = 15 * 60_000;
export const RESEND_COOLDOWN_MS = 30_000;
export const WRONG_CODE = 'That code is wrong or expired.';

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export interface CodeFaceProps {
  email: string;
  next: string;
  sentAt: number;
  request: MagicRequest;
  scene: SceneActions;
  codeRef: Ref<HTMLInputElement>;
  onBack: () => void;
}

/** Back face: the 6-digit code from the email, resend with a cooldown, or a different email. */
export function CodeFace({ email, next, sentAt, request, scene, codeRef, onBack }: CodeFaceProps) {
  const id = useId();
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<string>();
  const [cooldownUntil, setCooldownUntil] = useState(sentAt + RESEND_COOLDOWN_MS);
  const [sentAgain, setSentAgain] = useState(false);
  const now = useNow(Boolean(email));
  const left = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  useEffect(() => {
    if (!sentAgain) return;
    const t = setTimeout(() => setSentAgain(false), 2000);
    return () => clearTimeout(t);
  }, [sentAgain]);

  const consume = useMutation({
    mutationFn: () => api.action('POST', '/auth/magic/consume', { email, code }),
    onSuccess: () => {
      scene.succeed();
      goTo(next);
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 400) {
        setFieldError(WRONG_CODE);
        scene.fail({ expired: Date.now() - sentAt > CODE_TTL_MS });
        return;
      }
      setError(errorMessage(e));
      if (isApiError(e) && e.status === 429) scene.fail();
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
      setSentAgain(true);
      setCode('');
      setFieldError(undefined);
      return;
    }
    if ('challenge' in result) return setError(CHALLENGE_FAILED);
    setError(errorMessage(result.error));
    if (isApiError(result.error) && result.error.status === 429) scene.fail();
  }

  const noteId = `${id}-note`;
  const resendLabel =
    request.phase === 'checking'
      ? 'Checking…'
      : sentAgain
        ? 'Sent again'
        : left > 0
          ? `Resend in ${left}s`
          : 'Resend code';
  return (
    <div className="flex flex-col gap-6">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col">
          <Label htmlFor={id} className="mb-2">
            Code
          </Label>
          <CodeField
            id={id}
            value={code}
            onChange={(v) => {
              setCode(v);
              setFieldError(undefined);
              scene.gaze(v.length / CODE_LENGTH);
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
        <Button type="submit" size="lg" className="w-full" loading={consume.isPending}>
          Sign in
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-x-2">
          <Button
            variant="ghost"
            size="lg"
            className="px-3"
            disabled={left > 0 || sentAgain || request.phase !== 'idle'}
            loading={request.phase !== 'idle'}
            iconStart={
              sentAgain ? <Check aria-hidden className="wl-check" /> : <Mail aria-hidden />
            }
            onClick={() => void resend()}
          >
            {resendLabel}
          </Button>
          <Button variant="ghost" size="lg" className="px-3" onClick={onBack}>
            Use a different email
          </Button>
        </div>
      </form>
    </div>
  );
}
