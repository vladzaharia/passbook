import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { todoCount } from '@/shared/org-setup-checks.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';

/** The sidebar reads only the check levels, so the entry bundle carries none of the page's schema. */
const CountSchema = z.object({
  checks: z.array(z.object({ level: z.enum(['error', 'warn', 'info']) })),
});

/**
 * The sidebar's to-do count, by the one rule everything shares (todoCount). Its key
 * extends the page's, so a save that reloads the page reloads the count.
 */
function useBrandTodoCount(orgId: string): number {
  const mode = useMode();
  const query = useQuery({
    queryKey: ['orgs', 'pass-setup', orgId, mode, 'count'],
    queryFn: ({ signal }) =>
      api.get(`/api/v1/orgs/${encodeURIComponent(orgId)}/pass-setup`, CountSchema, {
        signal,
      }),
    retry: false,
    staleTime: 60_000,
  });
  return query.data ? todoCount(query.data.checks) : 0;
}

/** The count pill on the sidebar's Brand and channels item; its own chunk, so the entry stays small. */
export function BrandCount({ orgId }: { orgId: string }) {
  const todo = useBrandTodoCount(orgId);
  if (todo === 0) return null;
  return (
    <span className="ml-auto inline-flex min-h-5 min-w-5 items-center justify-center rounded-full border border-warning-border bg-warning-subtle px-1.5 text-xs font-medium text-warning tabular-nums">
      {todo}
      <span className="sr-only"> to do</span>
    </span>
  );
}
