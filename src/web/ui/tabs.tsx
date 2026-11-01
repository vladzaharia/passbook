import * as Primitive from '@radix-ui/react-tabs';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';

export const Tabs = Primitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof Primitive.List>) {
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
      el.scrollLeft = active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2;
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
  return (
    <div className="relative min-w-0">
      <Primitive.List
        ref={ref}
        className={cn('flex gap-1 overflow-x-auto border-b border-border', className)}
        {...props}
      />
      {fade.start ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-surface-page to-transparent"
        />
      ) : null}
      {fade.end ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface-page to-transparent"
        />
      ) : null}
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
        'relative -mb-px min-h-9 shrink-0 border-b-2 border-transparent px-3 text-sm text-fg-muted transition-colors',
        'hover:text-fg-strong data-[state=active]:border-accent data-[state=active]:text-fg-strong',
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
      className={cn('pt-4 focus-visible:outline-2 focus-visible:outline-focus', className)}
      {...props}
    />
  );
}
