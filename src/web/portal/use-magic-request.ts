import { useCallback, useMemo, useRef, useState } from 'react';
import { OkSchema } from '@/shared/contracts/common.ts';
import { api } from '../lib/api.ts';

/** How long an early submit waits for the Turnstile token. */
export const CHALLENGE_WAIT_MS = 10_000;

export const CHALLENGE_FAILED = 'Could not verify this browser. Reload and try again.';

export type SendResult =
  | { ok: true }
  | { ok: false; challenge: true }
  | { ok: false; error: unknown };

type Waiter = (token: string | null) => void;

/**
 * Turnstile tokens for the sign-in request and resends. Tokens are single use: taking one resets
 * the widget for the next. An early submit waits for the token (up to 10 s) instead of failing.
 */
function useChallenge() {
  const token = useRef<string | null>(null);
  const waiters = useRef(new Set<Waiter>());
  const [resetKey, setResetKey] = useState(0);
  const [failed, setFailed] = useState(false);

  const settle = useCallback((value: string | null) => {
    for (const wait of waiters.current) wait(value);
    waiters.current.clear();
  }, []);
  const onToken = useCallback(
    (value: string | null) => {
      token.current = value;
      if (value) {
        setFailed(false);
        if (waiters.current.size) {
          token.current = null;
          setResetKey((k) => k + 1);
          settle(value);
        }
      }
    },
    [settle],
  );
  const onError = useCallback(() => {
    setFailed(true);
    settle(null);
  }, [settle]);

  /** The current token (and a fresh challenge behind it), or null when none is ready. */
  const takeNow = useCallback((): string | null => {
    const value = token.current;
    if (!value) return null;
    token.current = null;
    setResetKey((k) => k + 1);
    return value;
  }, []);
  const wait = useCallback(
    (ms: number) =>
      new Promise<string | null>((resolve) => {
        const done: Waiter = (value) => {
          clearTimeout(timer);
          waiters.current.delete(done);
          resolve(value);
        };
        const timer = setTimeout(() => done(null), ms);
        waiters.current.add(done);
      }),
    [],
  );
  return { resetKey, failed, onToken, onError, takeNow, wait };
}

/**
 * POST /auth/magic/request behind the challenge. `phase` is 'checking' while an early submit
 * waits for Turnstile and 'sending' while the request runs.
 */
export function useMagicRequest(next: string | null) {
  const challenge = useChallenge();
  const [phase, setPhase] = useState<'idle' | 'checking' | 'sending'>('idle');
  const { takeNow, wait } = challenge;

  const send = useCallback(
    async (email: string): Promise<SendResult> => {
      let token = takeNow();
      if (!token) {
        setPhase('checking');
        token = await wait(CHALLENGE_WAIT_MS);
      }
      if (!token) {
        setPhase('idle');
        return { ok: false, challenge: true };
      }
      setPhase('sending');
      try {
        await api.post('/auth/magic/request', OkSchema, {
          email,
          turnstileToken: token,
          ...(next ? { next } : {}),
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      } finally {
        setPhase('idle');
      }
    },
    [next, takeNow, wait],
  );

  const widget = useMemo(
    () => ({
      resetKey: challenge.resetKey,
      onToken: challenge.onToken,
      onError: challenge.onError,
    }),
    [challenge.resetKey, challenge.onToken, challenge.onError],
  );
  return { send, phase, widget, challengeFailed: challenge.failed };
}

export type MagicRequest = ReturnType<typeof useMagicRequest>;
