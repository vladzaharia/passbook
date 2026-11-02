import {
  type FormEvent,
  type FormHTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { prefersReducedMotion } from '../lib/motion.ts';

const INVALID = '[aria-invalid="true"]';

export const attentionLine = (n: number) =>
  n === 1 ? '1 field needs attention' : `${n} fields need attention`;

/** The control to focus for an invalid element: a choice group focuses its checked or first option. */
function focusable(el: HTMLElement): HTMLElement | null {
  if (el.getAttribute('role') !== 'radiogroup') return el;
  return (
    el.querySelector<HTMLElement>('input:checked, [aria-checked="true"]') ??
    el.querySelector<HTMLElement>('input, [role="radio"], button')
  );
}

/**
 * Blocked submit (ui-consistency.md "Forms"): after the errors render, focus and scroll to the
 * first invalid control under `ref` and announce one polite summary ("2 fields need attention").
 */
export function useBlockedSubmit<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T>(null);
  const [tick, setTick] = useState(0);
  const [summary, setSummary] = useState('');
  useEffect(() => {
    if (tick === 0) return;
    const invalid = [...(ref.current?.querySelectorAll<HTMLElement>(INVALID) ?? [])];
    // A control inside an invalid group counts once.
    const roots = invalid.filter((el) => !invalid.some((o) => o !== el && o.contains(el)));
    const first = roots[0] ? focusable(roots[0]) : null;
    first?.focus({ preventScroll: true });
    first?.scrollIntoView({
      block: 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    // Clear first so the same count is announced again.
    setSummary('');
    const frame = requestAnimationFrame(() =>
      setSummary(roots.length ? attentionLine(roots.length) : ''),
    );
    return () => cancelAnimationFrame(frame);
  }, [tick]);
  return {
    ref,
    /** Call when a submit is refused; runs after the errors render. */
    block: () => setTick((t) => t + 1),
    live: (
      <p role="status" className="sr-only">
        {summary}
      </p>
    ),
  };
}

export interface FormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> {
  /** The form has errors: submit shows them, focuses the first and announces the count. */
  invalid: boolean;
  onValid: () => void;
  /** Show every field's error (set the caller's showErrors). */
  onInvalid?: () => void;
  children: ReactNode;
}

/** A form whose blocked submit focuses the first invalid field and announces one summary. */
export function Form({ invalid, onValid, onInvalid, children, ...props }: FormProps) {
  const blocked = useBlockedSubmit<HTMLFormElement>();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (invalid) {
      onInvalid?.();
      blocked.block();
    } else onValid();
  };
  return (
    <form ref={blocked.ref} noValidate onSubmit={submit} {...props}>
      {children}
      {blocked.live}
    </form>
  );
}
