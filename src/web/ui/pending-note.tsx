import { cn } from '../lib/cn.ts';
import { Spinner } from './spinner.tsx';

/**
 * A polling row: a spinner and a short label while background work runs (preview refresh,
 * upload processing). The only place besides Button that shows a Spinner.
 */
export function PendingNote({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm text-fg-muted', className)}>
      <Spinner label="" />
      <span role="status">{label}</span>
    </span>
  );
}
