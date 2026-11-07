import { cva, type VariantProps } from 'class-variance-authority';

export const buttonVariants = cva(
  [
    'relative inline-flex select-none items-center justify-center gap-2 rounded-md text-center font-medium whitespace-nowrap',
    'transition-[color,background-color,border-color,box-shadow,scale] duration-(--wl-dur-hover) ease-(--wl-ease-move)',
    'motion-safe:active:not-disabled:not-aria-disabled:scale-(--pk-motion-scale-press)',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
    // Working is not unavailable: a busy button keeps full contrast while its verb plays.
    'aria-busy:cursor-progress aria-busy:opacity-100',
    '[&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-accent-on shadow-elevation-1 hover:not-disabled:not-aria-disabled:bg-[color-mix(in_oklab,var(--pk-accent),var(--wl-hover-mix)_12%)] hover:not-disabled:not-aria-disabled:shadow-[var(--wl-glow-accent)] focus-visible:shadow-[var(--wl-glow-accent)]',
        secondary:
          'bg-state-hover-tint text-fg-strong hover:not-disabled:not-aria-disabled:bg-surface-sunken',
        outline:
          'border border-border-strong bg-transparent text-fg hover:not-disabled:not-aria-disabled:bg-state-hover-tint hover:not-disabled:not-aria-disabled:text-fg-strong',
        ghost:
          'bg-transparent text-fg hover:not-disabled:not-aria-disabled:bg-state-hover-tint hover:not-disabled:not-aria-disabled:text-fg-strong',
        danger:
          'bg-danger text-danger-on shadow-elevation-1 hover:not-disabled:not-aria-disabled:bg-[color-mix(in_oklab,var(--pk-danger),var(--wl-hover-mix)_12%)]',
        link: 'min-h-6 min-w-0 px-0 text-accent-fg underline-offset-4 hover:underline',
      },
      // Text is 14 px at every size; on touch every size is 44 tall (ui-consistency.md).
      size: {
        /** Card-header actions, row actions, list footers: 32, so a 48 px header or row holds it. */
        sm: 'min-h-8 min-w-8 px-3 py-1 text-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11 [&_svg]:size-4',
        md: 'min-h-9 min-w-9 px-4 py-1.5 text-sm pointer-coarse:min-h-11 [&_svg]:size-4',
        /** Beside the Add to Apple Wallet badge: the badge art's height, 40 (44 on touch). */
        badge:
          'min-h-10 min-w-10 px-4 py-1.5 text-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11 [&_svg]:size-4',
        lg: 'min-h-11 min-w-11 px-6 py-2 text-sm [&_svg]:size-4',
      },
    },
    compoundVariants: [{ variant: 'link', class: 'p-0 pointer-coarse:min-h-11' }],
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;
