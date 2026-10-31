import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { errorMessage, isApiError } from '../lib/errors.ts';
import { Button } from './button.tsx';

export interface ErrorStateProps {
  error?: unknown;
  title?: string;
  onRetry?: () => void;
  action?: ReactNode;
  className?: string;
}

export function ErrorState({ error, title = 'Could not load', onRetry, action, className }: ErrorStateProps) {
  const requestId = isApiError(error) ? error.requestId : undefined;
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border border-danger-border bg-danger-subtle px-6 py-10 text-center',
        className,
      )}
    >
      <AlertTriangle aria-hidden className="size-7 text-danger" />
      <p className="text-sm font-medium text-fg-strong">{title}</p>
      <p className="max-w-md text-sm text-fg-muted">{errorMessage(error)}</p>
      {requestId ? <p className="font-mono text-xs text-fg-subtle">Request {requestId}</p> : null}
      <div className="mt-2 flex gap-2">
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
        {action}
      </div>
    </div>
  );
}
