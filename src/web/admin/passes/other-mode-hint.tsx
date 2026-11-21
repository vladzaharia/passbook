import { useQuery } from '@tanstack/react-query';
import { MODE_HEADER } from '@/shared/contracts/common.ts';
import { PassListSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../lib/api.ts';
import { setMode, useMode } from '../../lib/mode.ts';
import { Button } from '../../ui/index.ts';

/** Passes the org holds in the other mode, for an empty list: `1 in Test [Show]`. */
export function OtherModeHint({ orgId, hidden }: { orgId: string | undefined; hidden: boolean }) {
  const mode = useMode();
  const other = mode === 'live' ? 'test' : 'live';
  const found = useQuery({
    queryKey: ['admin', 'passes', 'other-mode', orgId, other],
    enabled: Boolean(orgId) && !hidden,
    queryFn: ({ signal }) =>
      api.get('/api/v1/passes', PassListSchema, {
        query: { orgId, limit: 50 },
        headers: { [MODE_HEADER]: other },
        signal,
      }),
  });
  const count = found.data?.items.length ?? 0;
  if (hidden || count === 0) return null;
  const label = other === 'test' ? 'Test' : 'Live';
  return (
    <span className="inline-flex items-center gap-1">
      {count}
      {found.data?.nextCursor ? '+' : ''} in {label}
      <Button variant="link" size="sm" onClick={() => setMode(other)}>
        Show
      </Button>
    </span>
  );
}
