import { Slot, Slottable } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';
import { cn } from '../lib/cn.ts';
import { Spinner } from './spinner.tsx';

export const buttonVariants = cva(
  [
    'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium',
    'transition-[color,background-color,border-color,box-shadow,scale] duration-(--wl-dur-hover)',
    'active:not-disabled:not-aria-disabled:scale-(--pk-motion-scale-press)',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
    '[&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-accent-on shadow-elevation-1 hover:not-disabled:not-aria-disabled:bg-[color-mix(in_oklab,var(--pk-accent),white_12%)] hover:not-disabled:not-aria-disabled:shadow-[var(--wl-glow-accent)] focus-visible:shadow-[var(--wl-glow-accent)]',
        secondary:
          'bg-state-hover-tint text-fg-strong hover:not-disabled:not-aria-disabled:bg-surface-sunken',
        outline:
          'border border-border-strong bg-transparent text-fg hover:not-disabled:not-aria-disabled:bg-state-hover-tint hover:not-disabled:not-aria-disabled:text-fg-strong',
        ghost:
          'bg-transparent text-fg hover:not-disabled:not-aria-disabled:bg-state-hover-tint hover:not-disabled:not-aria-disabled:text-fg-strong',
        danger:
          'bg-danger text-danger-on shadow-elevation-1 hover:not-disabled:not-aria-disabled:bg-[color-mix(in_oklab,var(--pk-danger),white_12%)]',
        link: 'h-auto min-h-6 min-w-0 px-0 text-accent-fg underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 min-w-8 px-3 text-xs [&_svg]:size-4',
        md: 'h-9 min-w-9 px-4 text-sm [&_svg]:size-4',
        lg: 'h-10 min-w-10 px-6 text-sm [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'>,
    VariantProps<typeof buttonVariants> {
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  type?: 'button' | 'submit' | 'reset';
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  iconStart,
  iconEnd,
  type = 'button',
  children,
  onClick,
  ref,
  ...props
}: ButtonProps) {
  const blocked = loading || Boolean(disabled);
  const classes = cn(buttonVariants({ variant, size }), className);
  const guard = (e: MouseEvent<HTMLButtonElement>) => {
    if (blocked) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  if (asChild) {
    return (
      <Slot
        className={classes}
        aria-disabled={blocked || undefined}
        aria-busy={loading || undefined}
        onClick={guard}
        {...props}
      >
        {loading ? <Spinner label="" /> : iconStart}
        <Slottable>{children}</Slottable>
        {iconEnd}
      </Slot>
    );
  }
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={blocked}
      aria-busy={loading || undefined}
      onClick={guard}
      {...props}
    >
      {loading ? <Spinner label="" /> : iconStart}
      {children}
      {iconEnd}
    </button>
  );
}
