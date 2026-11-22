import { useQuery } from '@tanstack/react-query';
import { MODE_HEADER } from '@/shared/contracts/common.ts';
import { PassListSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../lib/api.ts';
import { setMode, useMode } from '../../lib/mode.ts';
import { Button } from '../../ui/index.ts';

/** Passes held in the other mode (of one template when given): the count, and whether there are more than counted. */
export function useOtherModePasses(
  orgId: string | undefined,
  hidden: boolean,
  templateId?: string,
) {
  const mode = useMode();
  const other: 'live' | 'test' = mode === 'live' ? 'test' : 'live';
  const found = useQuery({
    queryKey: ['admin', 'passes', 'other-mode', orgId, other, templateId ?? null],
    enabled: Boolean(orgId) && !hidden,
    queryFn: ({ signal }) =>
      api.get('/api/v1/passes', PassListSchema, {
        query: { orgId, limit: 50, ...(templateId ? { templateId } : {}) },
        headers: { [MODE_HEADER]: other },
        signal,
      }),
  });
  return {
    other,
    label: other === 'test' ? 'Test' : 'Live',
    count: hidden ? 0 : (found.data?.items.length ?? 0),
    more: Boolean(found.data?.nextCursor),
  };
}

/** The other mode's passes beside a template's own count: `· 1 in Test`. Nothing when there are none. */
export function TemplateOtherModeCount({
  orgId,
  templateId,
}: {
  orgId: string | undefined;
  templateId: string;
}) {
  const { count, more, label } = useOtherModePasses(orgId, false, templateId);
  if (count === 0) return null;
  return (
    <span>
      {'· '}
      {count}
      {more ? '+' : ''} in {label}
    </span>
  );
}

/** Passes the org holds in the other mode, for an empty list: `1 in Test [Show]`. */
export function OtherModeHint({ orgId, hidden }: { orgId: string | undefined; hidden: boolean }) {
  const { other, label, count, more } = useOtherModePasses(orgId, hidden);
  if (hidden || count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {count}
      {more ? '+' : ''} in {label}
      <Button variant="link" size="sm" onClick={() => setMode(other)}>
        Show
      </Button>
    </span>
  );
}
