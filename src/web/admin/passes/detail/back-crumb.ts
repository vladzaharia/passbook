import { useRouter, useRouterState } from '@tanstack/react-router';
import type { Crumb } from '../../../ui/page-header.tsx';

const ALL_LIST = '/admin/all/passes';

/**
 * The "Passes" crumb. A pass opened from the All list names that list in the router state
 * (`returnTo`); only the All list's own address is taken, so a crafted state cannot redirect.
 */
export function useBackCrumb(): Crumb {
  const router = useRouter();
  const returnTo: unknown = useRouterState({
    select: (state) => (state.location.state as { returnTo?: unknown }).returnTo,
  });
  if (typeof returnTo !== 'string') return { label: 'Passes', to: '/admin/passes' };
  const [path = '', query = ''] = returnTo.split('?', 2);
  if (path !== ALL_LIST) return { label: 'Passes', to: '/admin/passes' };
  return { label: 'Passes', to: ALL_LIST, search: router.options.parseSearch(`?${query}`) };
}
