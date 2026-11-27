import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import './kit.css';

export interface BenchMenuItem {
  key: string;
  label: string;
  /** A link opens; otherwise `onSelect` runs. */
  href?: string;
  onSelect?: () => void;
  /** Shown, but not a choice ("Not in your sandbox"). */
  disabled?: boolean;
}

const MOVE = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' } as const;
const GAP = 4;

/** Below the trigger, its end edge on the trigger's; above it when there is no room below. Fixed, so a scrolling pane never clips it. */
function place(trigger: HTMLElement, menu: HTMLElement) {
  const t = trigger.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const below = t.bottom + GAP + m.height <= innerHeight || t.top - GAP - m.height < 0;
  menu.style.top = `${below ? t.bottom + GAP : t.top - GAP - m.height}px`;
  menu.style.left = `${Math.max(8, Math.min(t.right - m.width, innerWidth - m.width - 8))}px`;
}

/**
 * The bench's one popover menu: elevation 3, focus moves in on open and back on close; arrows, Home
 * and End move; Esc, Tab, a choice, an outside press or a scroll close it. `onOpen` runs as it opens
 * (the IdChip resolves an unknown id then).
 */
export function BenchMenu({
  label,
  trigger,
  items,
  onOpen,
  footer,
  className,
  triggerClassName,
}: {
  /** The trigger's and the menu's name. */
  label: string;
  trigger: ReactNode;
  items: readonly BenchMenuItem[];
  onOpen?: () => void;
  /** A quiet line under the choices (what they do); it is not a choice. */
  footer?: ReactNode;
  className?: string;
  /** Styles the trigger (a kit button's classes); an IdChip's own is styled by the chip. */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const choices = () => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled])') ??
      []),
  ];
  const close = useCallback((focus: boolean) => {
    setOpen(false);
    if (focus) button.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (open && button.current && menu.current) place(button.current, menu.current);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `choices` reads the live menu; `items` arrive while it is open.
  useEffect(() => {
    if (!open) return;
    choices()[0]?.focus();
    const away = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    const scrolled = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', away);
    addEventListener('scroll', scrolled, true);
    addEventListener('resize', scrolled);
    return () => {
      document.removeEventListener('pointerdown', away);
      removeEventListener('scroll', scrolled, true);
      removeEventListener('resize', scrolled);
    };
  }, [open, items, close]);

  const onKey = (e: KeyboardEvent) => {
    const list = choices();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key in MOVE && open) {
      e.preventDefault();
      const by = MOVE[e.key as keyof typeof MOVE];
      const i = by === 'first' ? 0 : by === 'last' ? list.length - 1 : at + by;
      list[(i + list.length) % list.length]?.focus();
    } else if (e.key === 'Tab') setOpen(false);
  };
  const toggle = () => {
    if (!open) onOpen?.();
    setOpen((o) => !o);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keys reach the menu's own controls; this only routes them
    <span ref={root} className={className ? `bench-mn ${className}` : 'bench-mn'} onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        className={triggerClassName ? `bench-mn-t ${triggerClassName}` : 'bench-mn-t'}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
      >
        {trigger}
      </button>
      <div ref={menu} id={id} className="bench-mn-l" role="menu" aria-label={label} hidden={!open}>
        {items.map((item) =>
          item.href && !item.disabled ? (
            <a
              key={item.key}
              role="menuitem"
              tabIndex={-1}
              className="bench-mn-i"
              href={item.href}
              onClick={() => close(false)}
            >
              {item.label}
            </a>
          ) : (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="bench-mn-i"
              aria-disabled={item.disabled || undefined}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect?.();
                close(true);
              }}
            >
              {item.label}
            </button>
          ),
        )}
        {footer ? <span className="bench-mn-f">{footer}</span> : null}
      </div>
    </span>
  );
}
