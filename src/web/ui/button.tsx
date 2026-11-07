import { Slot, Slottable } from '@radix-ui/react-slot';
import { Check, Copy } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  isValidElement,
  type MouseEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../lib/cn.ts';
import { useChangeCount } from '../lib/motion.ts';
import { type ButtonVariantProps, buttonVariants } from './button-variants.ts';
import { Spinner } from './spinner.tsx';

export { buttonVariants } from './button-variants.ts';

/** A 44 × 44 hit area around a smaller control on touch screens. */
export const TOUCH_HIT =
  "pointer-coarse:before:absolute pointer-coarse:before:top-1/2 pointer-coarse:before:left-1/2 pointer-coarse:before:size-11 pointer-coarse:before:-translate-1/2 pointer-coarse:before:content-['']";

/**
 * Pending loops for the leading icon (docs/design/motion-and-expression.md "Action verbs"):
 * spin (RefreshCw), pulse (Zap), bob (Upload). They run under reduced motion: they carry state.
 */
export type BusyVerb = 'spin' | 'pulse' | 'bob';

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'>,
    ButtonVariantProps {
  /** Disables the button; shows a spinner, or animates the icon when `busy` is set. */
  loading?: boolean;
  /** Keeps `iconStart` while loading and plays this verb on it instead of a spinner. */
  busy?: BusyVerb;
  /** Change this value when the server confirms: the icon plays its confirm verb once. */
  done?: unknown;
  /** Plays the confirm verb backwards (KeyRound on revoke). */
  undo?: boolean;
  /** An offline mutation waits for the network: the label reads "Waiting for connection". */
  paused?: boolean;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  type?: 'button' | 'submit' | 'reset';
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

const isCopy = (node: ReactNode) => isValidElement(node) && node.type === Copy;

/** One-shot data-verb-done after `done` changes; Copy shows a popping Check meanwhile. */
function useVerbDone(done: unknown) {
  const changed = useChangeCount(done);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!changed) return;
    setActive(changed);
    const t = setTimeout(() => setActive(0), 1500);
    return () => clearTimeout(t);
  }, [changed]);
  return active;
}

/**
 * A variant swap (primary to outline when a list loads empty) is a fact, not a change to animate:
 * the colour transitions stay off for the frame the swap lands in.
 */
function useInstantVariant(own: { current: HTMLElement | null }, variant: unknown) {
  const prev = useRef(variant);
  useLayoutEffect(() => {
    if (prev.current === variant) return;
    prev.current = variant;
    const el = own.current;
    if (!el) return;
    el.setAttribute('data-instant', '');
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => el.removeAttribute('data-instant'));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      el.removeAttribute('data-instant');
    };
  }, [own, variant]);
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  busy,
  done,
  undo,
  paused,
  disabled,
  iconStart,
  iconEnd,
  type = 'button',
  children,
  onClick,
  ref,
  ...props
}: ButtonProps) {
  const blocked = loading || paused || Boolean(disabled);
  const verbDone = useVerbDone(done);
  const own = useRef<HTMLElement | null>(null);
  useInstantVariant(own, variant);
  // Restart the one-shot animation on every confirmation.
  useEffect(() => {
    const el = own.current;
    if (!verbDone || !el) return;
    el.removeAttribute('data-verb-done');
    void el.offsetWidth;
    el.setAttribute('data-verb-done', undo ? 'undo' : '');
  }, [verbDone, undo]);
  const classes = cn(buttonVariants({ variant, size }), className);
  const guard = (e: MouseEvent<HTMLButtonElement>) => {
    if (blocked) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  const keepIcon = loading && busy && iconStart;
  const icon =
    loading && !keepIcon ? (
      <Spinner label="" />
    ) : verbDone && isCopy(iconStart) ? (
      <Check aria-hidden className="wl-check" />
    ) : (
      iconStart
    );
  const label = paused ? 'Waiting for connection' : children;
  const state = {
    'aria-busy': loading || undefined,
    'data-busy': keepIcon ? busy : undefined,
    'data-paused': paused || undefined,
  };
  const setRef = (el: HTMLButtonElement | null) => {
    own.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  if (asChild) {
    return (
      <Slot
        ref={setRef}
        className={classes}
        aria-disabled={blocked || undefined}
        onClick={guard}
        {...state}
        {...props}
      >
        {icon}
        <Slottable>{children}</Slottable>
        {iconEnd}
      </Slot>
    );
  }
  return (
    <button
      ref={setRef}
      type={type}
      className={classes}
      disabled={blocked}
      onClick={guard}
      {...state}
      {...props}
    >
      {icon}
      {label}
      {iconEnd}
    </button>
  );
}
