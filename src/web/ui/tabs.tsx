import * as Primitive from '@radix-ui/react-tabs';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Children,
  type ComponentProps,
  createContext,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../lib/cn.ts';
import { PHONE, useMediaQuery } from '../lib/media.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { ActiveIndicator } from './active-indicator.tsx';
import { IconButton } from './icon-button.tsx';
import { Select } from './select.tsx';

interface TabsState {
  value: string | undefined;
  setValue: (value: string) => void;
}
const TabsContext = createContext<TabsState | null>(null);

/** Radix tabs that share their value with the phone select (TabsList, five tabs or more). */
export function Tabs({
  value,
  defaultValue,
  onValueChange,
  ...props
}: ComponentProps<typeof Primitive.Root>) {
  const [own, setOwn] = useState(defaultValue);
  const current = value ?? own;
  const setValue = (next: string) => {
    if (value === undefined) setOwn(next);
    onValueChange?.(next);
  };
  return (
    <TabsContext.Provider value={{ value: current, setValue }}>
      <Primitive.Root value={current} onValueChange={setValue} {...props} />
    </TabsContext.Provider>
  );
}

const textOf = (node: ReactNode): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join('')
      : isValidElement<{ children?: ReactNode }>(node)
        ? textOf(node.props.children)
        : '';

/** Below 640 five or more tabs become a Select ("Section: Fields"); else a scrolling strip. */
export function TabsList({ className, children, ...props }: ComponentProps<typeof Primitive.List>) {
  const state = useContext(TabsContext);
  const phone = useMediaQuery(PHONE);
  const triggers = Children.toArray(children).filter(
    (c): c is ReactElement<{ value: string; children?: ReactNode; disabled?: boolean }> =>
      isValidElement<{ value?: string }>(c) && typeof c.props.value === 'string',
  );
  if (phone && state && triggers.length >= 5) {
    return (
      <Select
        label="Section"
        className="w-full"
        value={state.value}
        onValueChange={state.setValue}
        options={triggers.map((t) => ({
          value: t.props.value,
          label: textOf(t.props.children),
          disabled: t.props.disabled,
        }))}
      />
    );
  }
  return (
    <Strip className={className} {...props}>
      {children}
    </Strip>
  );
}

function Strip({ className, children, ...props }: ComponentProps<typeof Primitive.List>) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
    };
    const reveal = () => {
      const active = el.querySelector<HTMLElement>('[data-state=active]');
      if (!active || el.scrollWidth <= el.clientWidth) return;
      el.scrollTo({
        left: active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    };
    reveal();
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const mo = new MutationObserver(() => {
      reveal();
      measure();
    });
    mo.observe(el, { attributes: true, attributeFilter: ['data-state'], subtree: true });
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      mo.disconnect();
      ro?.disconnect();
    };
  }, []);
  const page = (dir: 1 | -1) => {
    const el = ref.current;
    el?.scrollBy({
      left: dir * el.clientWidth * 0.7,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  };
  // The chevron sits on solid page colour with the fade beyond it, so no half-clipped label
  // shows under it. The underline border stays visible.
  const edge = (side: 'start' | 'end') => (
    <div
      className={cn(
        'pointer-events-none absolute top-0 bottom-px flex items-stretch',
        side === 'start' ? 'left-0' : 'right-0 flex-row-reverse',
      )}
    >
      <span className="flex items-center bg-surface-page">
        <IconButton
          label={side === 'start' ? 'Earlier tabs' : 'More tabs'}
          size="sm"
          tabIndex={-1}
          className="pointer-events-auto size-6"
          icon={side === 'start' ? <ChevronLeft aria-hidden /> : <ChevronRight aria-hidden />}
          onClick={() => page(side === 'start' ? -1 : 1)}
        />
      </span>
      <span
        aria-hidden
        className={cn(
          'w-8 from-surface-page to-transparent',
          side === 'start' ? 'bg-gradient-to-r' : 'bg-gradient-to-l',
        )}
      />
    </div>
  );
  return (
    <div className="relative min-w-0">
      <Primitive.List
        ref={ref}
        className={cn(
          'relative flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]',
          className,
        )}
        {...props}
      >
        <ActiveIndicator variant="underline" />
        {children}
      </Primitive.List>
      {fade.start ? edge('start') : null}
      {fade.end ? edge('end') : null}
    </div>
  );
}

export function TabsTrigger({
  className,
  onPointerDown,
  onKeyDown,
  onBlur,
  ...props
}: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      onPointerDown={(e) => {
        e.currentTarget.dataset.pointer = '';
        onPointerDown?.(e);
      }}
      onKeyDown={(e) => {
        delete e.currentTarget.dataset.pointer;
        onKeyDown?.(e);
      }}
      onBlur={(e) => {
        delete e.currentTarget.dataset.pointer;
        onBlur?.(e);
      }}
      className={cn(
        'relative -mb-px min-h-9 shrink-0 border-b-2 border-transparent px-3 text-sm text-fg-muted wl-colors pointer-coarse:min-h-11',
        'hover:text-fg-strong data-[state=active]:text-fg-strong',
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
        // Radix focuses the trigger on pointer down; only keyboard focus shows the ring.
        'data-pointer:focus-visible:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Content
      className={cn('wl-panel pt-4 focus-visible:outline-2 focus-visible:outline-focus', className)}
      {...props}
    />
  );
}
