import { Link } from '@tanstack/react-router';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { Button } from './button.tsx';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'relative min-w-0 rounded-lg border border-border bg-surface-raised shadow-[var(--wl-edge),var(--pk-elevation-1)]',
        className,
      )}
      {...props}
    />
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  /** CardLink buttons (ghost sm with a trailing chevron or arrow). */
  actions?: ReactNode;
  as?: 'h2' | 'h3';
  className?: string;
}

/** Title left, actions right; actions wrap below the title when the card is narrow. */
export function CardHeader({ title, actions, as: Tag = 'h2', className }: CardHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3',
        className,
      )}
    >
      <Tag className="min-w-0 text-sm font-semibold text-fg-strong">{title}</Tag>
      {actions ? <div className="flex flex-wrap items-center gap-1">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}

/**
 * A card-header action: ghost sm with ChevronRight for an internal page, ArrowUpRight for an
 * external one. Never an underlined link.
 */
export function CardLink({
  to,
  href,
  children,
}: {
  to?: string;
  href?: string;
  children: ReactNode;
}) {
  if (href) {
    return (
      <Button asChild variant="ghost" size="sm" iconEnd={<ArrowUpRight aria-hidden />}>
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      </Button>
    );
  }
  return (
    <Button asChild variant="ghost" size="sm" iconEnd={<ChevronRight aria-hidden />}>
      <Link to={(to ?? '/') as never}>{children}</Link>
    </Button>
  );
}
