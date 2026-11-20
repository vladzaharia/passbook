import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The digits being keyed, behind a private field: a hooks panel or a state dump shows an empty
 * object, never the digits. `take` hands them over once and forgets them.
 */
class Digits {
  #value = '';
  get size() {
    return this.#value.length;
  }
  add(digit: string) {
    this.#value += digit;
  }
  drop() {
    this.#value = this.#value.slice(0, -1);
  }
  take() {
    const value = this.#value;
    this.#value = '';
    return value;
  }
}

/**
 * A PIN being keyed. The screen only learns how many digits there are. They are dropped when the
 * app goes to the background, after a pause, on `clear` (a different manager), and with the
 * component; `onFull` takes them once and they are gone.
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
  const digits = useRef(new Digits());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [count, setCount] = useState(0);
  const latest = useRef({ onFull, onCleared });
  latest.current = { onFull, onCleared };
  const clear = useCallback((announce = false) => {
    clearTimeout(timer.current);
    const had = digits.current.size > 0;
    digits.current.take();
    setCount(0);
    if (announce && had) latest.current.onCleared?.();
  }, []);
  const arm = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => clear(true), idleMs);
  }, [clear, idleMs]);
  const push = useCallback(
    (digit: string) => {
      if (disabled || !/^\d$/.test(digit) || digits.current.size >= length) return;
      digits.current.add(digit);
      if (digits.current.size === length) {
        clearTimeout(timer.current);
        setCount(0);
        latest.current.onFull(digits.current.take());
        return;
      }
      setCount(digits.current.size);
      arm();
    },
    [disabled, length, arm],
  );
  const pop = useCallback(() => {
    if (disabled || digits.current.size === 0) return;
    digits.current.drop();
    setCount(digits.current.size);
    if (digits.current.size > 0) arm();
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
      digits.current.take();
    };
  }, [clear]);
  return { count, push, pop, clear };
}
