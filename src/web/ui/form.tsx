import {
  type FormEvent,
  type FormHTMLAttributes,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { prefersReducedMotion } from '../lib/motion.ts';
import { type GroupedForm, SaveBarGroupContext, type SaveHandler } from './save-bar.tsx';

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

/**
 * Errors appear on submit, then follow the values: none show while the user types into a fresh
 * form; after a refused submit each message clears on the keystroke that fixes it (and comes back
 * if the value breaks again). Spread `form` on the kit Form and read `errors` for the fields:
 *
 *   const check = useFormErrors(validate(values));
 *   <Form {...check.form} onValid={save}><FormField error={check.errors.name}>…
 */
export function useFormErrors<E extends Partial<Record<string, string>>>(found: E) {
  const [shown, setShown] = useState(false);
  return {
    /** The errors to render: empty until a submit is refused. */
    errors: shown ? found : ({} as Partial<E>),
    form: {
      invalid: Object.values(found).some(Boolean),
      onInvalid: () => setShown(true),
    },
    /** After a successful submit or a reset, hide them again. */
    reset: () => setShown(false),
  };
}

export interface FormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> {
  /** The form has errors: submit shows them, focuses the first and announces the count. */
  invalid: boolean;
  /** May resolve how the save ended: 'refused' (server field errors) focuses them like a block. */
  onValid: SaveHandler;
  /** Show every field's error (set the caller's showErrors). */
  onInvalid?: () => void;
  children: ReactNode;
}

/**
 * A form whose blocked submit focuses the first invalid field and announces one summary. Pair it
 * with useFormErrors. A Save or Next button outside the form submits it with `form={id}`
 * (SaveBar and Wizard take a formId). In a SaveBarGroup the page's Save submits it, and Enter
 * saves the page.
 */
export function Form({ id, invalid, onValid, onInvalid, children, ...props }: FormProps) {
  const blocked = useBlockedSubmit<HTMLFormElement>();
  const group = useContext(SaveBarGroupContext);
  const self = useRef<GroupedForm>({ invalid, onValid, onInvalid, block: blocked.block });
  self.current = { invalid, onValid, onInvalid, block: blocked.block };
  useEffect(() => {
    if (!group || !id) return;
    group.form(id, self);
    return () => group.form(id, null);
  }, [group, id]);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (group && id && group.has(id)) return group.save();
    if (invalid) {
      onInvalid?.();
      blocked.block();
      return;
    }
    const saving = onValid();
    if (saving instanceof Promise)
      void saving.then((result) => result === 'refused' && blocked.block());
  };
  return (
    <form ref={blocked.ref} id={id} noValidate onSubmit={submit} {...props}>
      {children}
      {blocked.live}
    </form>
  );
}
