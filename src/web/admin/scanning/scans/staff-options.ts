import { useQuery } from '@tanstack/react-query';
import { pageOf } from '@/shared/contracts/common.ts';
import { ScanStaffSchema } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';

const StaffPageSchema = pageOf(ScanStaffSchema);

/** The org's staff for the Staff filter; a long roster shows its first 100. */
export function useStaffOptions(orgId: string | undefined) {
  const mode = useMode();
  return useQuery({
    queryKey: ['admin', 'scanning', 'staff', 'options', orgId, mode],
    queryFn: ({ signal }) => {
      if (!orgId) throw new Error('Choose an organization.');
      return api.get('/api/v1/scan-staff', StaffPageSchema, {
        query: { orgId, limit: 100 },
        signal,
      });
    },
    enabled: Boolean(orgId),
    staleTime: 60_000,
  });
}
