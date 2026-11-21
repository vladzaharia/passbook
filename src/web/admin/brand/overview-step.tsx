import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { PASS_FIX_COPY } from '@/shared/copy/pass-setup-fix.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { Button } from '@/web/ui/index.ts';
import { usePassSetup } from './api.ts';

const COPY = PASS_FIX_COPY.overview;

/** The Overview's step 1 as a Checklist step: the open to-dos and the first three by name. */
export interface BrandStep {
  id: 'brand';
  label: ReactNode;
  done: boolean;
  action: ReactNode;
}

/**
 * Brand and channels, from the org's own setup checks (warnings and errors count, suggestions do
 * not). It never gates the steps after it: they stay open while it is not done. Absent while the
 * checks load, fail, or the member cannot read them.
 */
export function useBrandStep(orgId: string | undefined): BrandStep | undefined {
  const setup = usePassSetup(orgId ?? '', orgId !== undefined);
  if (!orgId || !setup.data) return undefined;
  const todo = setup.data.checks.filter((c) => c.level !== 'info');
  const names = [...new Set(todo.map((c) => COPY.names[c.code]))].slice(0, 3);
  return {
    id: 'brand',
    done: todo.length === 0,
    label: (
      <>
        {COPY.step}
        <span className="block text-xs text-fg-muted">
          {todo.length === 0
            ? COPY.ready
            : [scanLine(COPY.toDo, { n: todo.length }), ...names].join(' · ')}
        </span>
      </>
    ),
    action: (
      <Button asChild size="sm" variant="outline" iconEnd={<ChevronRight aria-hidden />}>
        <Link to="/admin/o/$orgId/brand" params={{ orgId }}>
          {COPY.open}
        </Link>
      </Button>
    ),
  };
}
