import { PASS_FIX_COPY } from '@/shared/copy/pass-setup-fix.ts';
import { usePassSetup } from './api.ts';

const COPY = PASS_FIX_COPY.overview;

/** The open brand and channel to-dos: how many, and the first three by name. */
export interface BrandTodo {
  count: number;
  names: string[];
}

/**
 * Brand and channels, from the org's own setup checks (warnings and errors count, suggestions do
 * not). Undefined while the checks load, fail, the member cannot read them, or nothing is left.
 * It is a suggestion: the steps around it never wait on it.
 */
export function useBrandStep(orgId: string | undefined): BrandTodo | undefined {
  const setup = usePassSetup(orgId ?? '', orgId !== undefined);
  if (!orgId || !setup.data) return undefined;
  const todo = setup.data.checks.filter((c) => c.level !== 'info');
  if (todo.length === 0) return undefined;
  return {
    count: todo.length,
    names: [...new Set(todo.map((c) => COPY.names[c.code]))].slice(0, 3),
  };
}
