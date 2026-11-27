import * as Primitive from '@radix-ui/react-dropdown-menu';
import {
  type ComponentProps,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useRef,
} from 'react';
import { cn } from '../lib/cn.ts';
import { inertOutside } from './inert-outside.ts';
import { nameWrapper } from './popper-region.ts';

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  collisionPadding = 16,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  const restore = useRef<(() => void) | null>(null);
  const mount = useCallback((node: HTMLDivElement | null) => {
    restore.current?.();
    restore.current = node ? inertOutside(node) : null;
    nameWrapper(node, 'Menu');
  }, []);
  return (
    <Primitive.Portal>
      <Primitive.Content
        ref={mount}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'wl-pop origin-(--radix-dropdown-menu-content-transform-origin) z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-44 overflow-y-auto overscroll-contain rounded-md border border-border bg-surface-overlay p-1 shadow-elevation-2',
          // Phones: an action sheet anchored to the bottom edge (kit-motion.css .wl-action-sheet).
          'wl-action-sheet max-sm:w-screen max-sm:rounded-b-none max-sm:rounded-t-xl max-sm:p-2 max-sm:pb-[max(0.5rem,env(safe-area-inset-bottom))]',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

const ITEM =
  'flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg outline-hidden max-sm:min-h-11 pointer-coarse:min-h-11 data-disabled:opacity-50 data-highlighted:bg-state-hover-tint data-highlighted:text-fg-strong [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted';

/**
 * The menu opens on pointer down, so on a phone's bottom action sheet an item can land under the
 * finger and the gesture that opened it would activate it: its pointer up, or the click the browser
 * sends to whatever is under the finger afterwards (a touch's pointer up stays on the trigger, its
 * click does not). Touch, pen and coarse-pointer devices (whose taps can report as mouse) ignore
 * the opening gesture's pointer up (matched by `pointerId`) and its click. A fresh press on an
 * item ends the guard, so a deliberate tap always selects; mouse press-drag-release and keyboard
 * select immediately.
 */
const OPENING_GESTURE_MS = 350;
/** A click follows its pointer up within a frame or two; this bounds how late one still counts as the same gesture. */
const CLICK_AFTER_UP_MS = 400;

interface Press {
  id: number;
  /** Touch or pen: Safari and Firefox send a MouseEvent for the click, so the press says what it was. */
  touch: boolean;
  up: number | null;
}
let lastPress: Press | null = null;
let tracking = false;

function track() {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPress = {
        id: e.pointerId,
        touch: e.pointerType === 'touch' || e.pointerType === 'pen',
        up: null,
      };
    },
    true,
  );
  const end = (e: globalThis.PointerEvent) => {
    if (lastPress && lastPress.id === e.pointerId) lastPress.up = performance.now();
  };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
}

const coarse = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;
const isTouchLike = (event: PointerEvent) =>
  event.pointerType === 'touch' || event.pointerType === 'pen' || coarse();

/** Handlers for an item: compose them with your own on every menu item that activates on pointer up or click. */
export function useIgnoreOpeningGesture() {
  track();
  const mounted = useRef<{ at: number; press: Press | null } | null>(null);
  if (mounted.current === null) mounted.current = { at: performance.now(), press: lastPress };
  const pressed = useRef(false);
  const { at, press } = mounted.current;
  return {
    onPointerDown: () => {
      pressed.current = true;
    },
    onPointerUp: (event: PointerEvent) => {
      if (pressed.current || !isTouchLike(event)) return;
      const opener = press
        ? event.pointerId === press.id
        : performance.now() - at < OPENING_GESTURE_MS;
      if (opener) event.preventDefault();
    },
    onClick: (event: MouseEvent) => {
      // detail 0 is the keyboard, or Radix's own click from a pointer up that the guard let through.
      if (pressed.current || event.detail === 0) return;
      if (!(press?.touch || coarse())) return;
      const now = performance.now();
      const same = press
        ? lastPress === press && (press.up === null || now - press.up < CLICK_AFTER_UP_MS)
        : now - at < OPENING_GESTURE_MS;
      if (same) event.preventDefault();
    },
  };
}

export function DropdownMenuItem({
  className,
  destructive,
  onPointerDown,
  onPointerUp,
  onClick,
  ...props
}: ComponentProps<typeof Primitive.Item> & { destructive?: boolean }) {
  const opening = useIgnoreOpeningGesture();
  return (
    <Primitive.Item
      className={cn(ITEM, destructive && 'text-danger [&_svg]:text-danger', className)}
      onPointerDown={(e) => {
        onPointerDown?.(e);
        opening.onPointerDown();
      }}
      onPointerUp={(e) => {
        onPointerUp?.(e);
        opening.onPointerUp(e);
      }}
      onClick={(e) => {
        onClick?.(e);
        opening.onClick(e);
      }}
      {...props}
    />
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  onPointerDown,
  onPointerUp,
  onClick,
  ...props
}: ComponentProps<typeof Primitive.RadioItem>) {
  const opening = useIgnoreOpeningGesture();
  return (
    <Primitive.RadioItem
      className={cn(ITEM, 'pl-7 relative', className)}
      onPointerDown={(e) => {
        onPointerDown?.(e);
        opening.onPointerDown();
      }}
      onPointerUp={(e) => {
        onPointerUp?.(e);
        opening.onPointerUp(e);
      }}
      onClick={(e) => {
        onClick?.(e);
        opening.onClick(e);
      }}
      {...props}
    >
      <Primitive.ItemIndicator className="absolute left-2 size-2 rounded-full bg-accent" />
      {children}
    </Primitive.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label className={cn('px-2 py-1.5 text-xs text-fg-muted', className)} {...props} />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn('my-1 h-px bg-border', className)} {...props} />;
}
