import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '../lib/cn.ts';
import { Tooltip } from './tooltip.tsx';

const iconButtonVariants = cva(
  [
    'relative inline-flex shrink-0 items-center justify-center rounded-md',
    'transition-[color,background-color,border-color,scale] duration-(--wl-dur-hover) ease-(--wl-ease-move)',
    'motion-safe:active:not-disabled:scale-(--pk-motion-scale-press)',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    'disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4',
  ],
  {
    variants: {
      variant: {
        ghost:
          'text-fg-muted hover:not-disabled:bg-state-hover-tint hover:not-disabled:text-fg-strong',
        outline:
          'border border-border-strong text-fg hover:not-disabled:bg-state-hover-tint hover:not-disabled:text-fg-strong',
      },
      // 44 on touch at every size, like Button. `badge` sits beside the Apple badge (40).
      size: {
        sm: 'size-8 pointer-coarse:size-11',
        md: 'size-9 pointer-coarse:size-11',
        badge: 'size-10 pointer-coarse:size-11',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
);

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'aria-label'>,
    VariantProps<typeof iconButtonVariants> {
  /** Required: icon-only buttons need an accessible name. Also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  type?: 'button' | 'submit';
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  label,
  icon,
  variant,
  size,
  className,
  type = 'button',
  ref,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip content={label}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={cn(iconButtonVariants({ variant, size }), className)}
        {...props}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
