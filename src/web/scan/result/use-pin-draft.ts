import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The digits of a PIN being keyed. They live in a ref, never in state, storage or the DOM: the
 * screen only learns how many there are. They are dropped when the app goes to the background,
 * after a pause, and with the component; `onFull` takes them once and they are gone.
 */
export function usePinDraft({
  length,
  idleMs,
  disabled,
  onFull,
  onCleared,
}: {
  length: number;
  idleMs: number;
  disabled: boolean;
  onFull: (pin: string) => void;
  onCleared?: () => void;
}) {
  const digits = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [count, setCount] = useState(0);
  const latest = useRef({ onFull, onCleared });
  latest.current = { onFull, onCleared };
  const clear = useCallback((announce = false) => {
    clearTimeout(timer.current);
    const had = digits.current.length > 0;
    digits.current = '';
    setCount(0);
    if (announce && had) latest.current.onCleared?.();
  }, []);
  const arm = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => clear(true), idleMs);
  }, [clear, idleMs]);
  const push = useCallback(
    (digit: string) => {
      if (disabled || !/^\d$/.test(digit) || digits.current.length >= length) return;
      digits.current += digit;
      if (digits.current.length === length) {
        const pin = digits.current;
        clear();
        latest.current.onFull(pin);
        return;
      }
      setCount(digits.current.length);
      arm();
    },
    [disabled, length, clear, arm],
  );
  const pop = useCallback(() => {
    if (disabled || !digits.current) return;
    digits.current = digits.current.slice(0, -1);
    setCount(digits.current.length);
    if (digits.current) arm();
    else clearTimeout(timer.current);
  }, [disabled, arm]);
  useEffect(() => {
    const drop = () => clear(true);
    const hidden = () => document.visibilityState === 'hidden' && drop();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', drop);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', drop);
      clearTimeout(timer.current);
      digits.current = '';
    };
  }, [clear]);
  return { count, push, pop, clear };
}
