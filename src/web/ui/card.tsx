import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-surface-raised shadow-elevation-1', className)}
      {...props}
    />
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  actions?: ReactNode;
  as?: 'h2' | 'h3';
  className?: string;
}

export function CardHeader({ title, actions, as: Tag = 'h2', className }: CardHeaderProps) {
  return (
    <div className={cn('flex items-center justify-between gap-3 border-b border-border px-4 py-3', className)}>
      <Tag className="text-sm font-semibold text-fg-strong">{title}</Tag>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}
