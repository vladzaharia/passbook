import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { PASS_FIX_COPY } from '@/shared/copy/pass-setup-fix.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { Button } from '@/web/ui/index.ts';
import { useBrandStep } from '../brand/overview-step.tsx';

const COPY = PASS_FIX_COPY.overview;

/**
 * Brand and channels beside the first pass, never part of it: the path's steps do not wait on it.
 * Shown only while there is something to do; nothing while the checks load, fail, or are unreadable.
 */
export function BrandRow({ orgId }: { orgId: string }) {
  const todo = useBrandStep(orgId);
  if (!todo) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-raised px-4 py-3">
      <p className="m-0 min-w-0 text-sm font-medium text-fg-strong">
        {COPY.step}
        <span className="block text-xs font-normal text-fg-muted">
          {[scanLine(COPY.toDo, { n: todo.count }), ...todo.names].join(' · ')}
        </span>
      </p>
      <Button asChild size="sm" variant="outline" iconEnd={<ChevronRight aria-hidden />}>
        <Link to="/admin/o/$orgId/brand" params={{ orgId }}>
          {COPY.open}
        </Link>
      </Button>
    </div>
  );
}
