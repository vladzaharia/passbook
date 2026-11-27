import { useQuery } from '@tanstack/react-query';
import { pageOf } from '@/shared/contracts/common.ts';
import { ScannerKindSchema, ScannerSchema } from '@/shared/contracts/scanners.ts';
import { useToolApi } from '@/web/lib/tool-api.tsx';
import { useKeysRoot } from './queries.ts';

const TerminalListSchema = pageOf(
  ScannerSchema.pick({ id: true, name: true, status: true }).extend({ kind: ScannerKindSchema }),
);

/** The org's terminals in service: the only devices a scan key can act as. */
export function useTerminals(orgId: string | null, enabled: boolean) {
  const api = useToolApi();
  const root = useKeysRoot();
  return useQuery({
    queryKey: [...root, 'terminals', orgId],
    enabled: enabled && orgId !== null,
    queryFn: async ({ signal }) => {
      const page = await api.get('/api/v1/scanners', TerminalListSchema, {
        query: { orgId: orgId ?? undefined, limit: 100 },
        signal,
      });
      return page.items.filter((s) => s.kind === 'terminal' && s.status !== 'revoked');
    },
  });
}
