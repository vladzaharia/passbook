import { useQuery } from '@tanstack/react-query';
import { SettingsImpactSchema } from '@/shared/contracts/settings.ts';
import { api } from '@/web/lib/api.ts';

export function useEmailOnlyUsers() {
  return useQuery({
    queryKey: ['settings', 'impact'],
    queryFn: ({ signal }) => api.get('/api/v1/settings/impact', SettingsImpactSchema, { signal }),
    staleTime: 10_000,
  });
}

/** The confirm's consequence: how many people this locks out. */
export function MagicLinkImpact() {
  const impact = useEmailOnlyUsers();
  if (impact.isPending) return <>Counting users who sign in by email…</>;
  if (impact.isError) return <>Users without Polaris ID will not be able to sign in.</>;
  const n = impact.data.emailOnlyUsers;
  if (n === 0) return <>No active users sign in by email only.</>;
  return (
    <>
      <strong className="font-semibold text-fg-strong tabular-nums">
        {n} {n === 1 ? 'user' : 'users'}
      </strong>{' '}
      {n === 1 ? 'signs' : 'sign'} in by email only and will not be able to sign in.
    </>
  );
}
