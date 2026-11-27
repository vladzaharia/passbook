import { useQuery } from '@tanstack/react-query';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { PATHS } from '@/shared/developers.ts';
import { DesignerSkeleton } from '../../../admin/templates/designer/designer-skeleton.tsx';
import { useSession } from '../../../lib/session.ts';
import '../design.css';
import { Callout } from '../../../ui/callout.tsx';
import type { BlueprintPreviews } from '../../playground/model.ts';
import { ToolPage } from '../../shell/tool-page.tsx';
import { ToolFailed } from '../../states/states.tsx';
import { AnonProvider } from './anon-context.tsx';
import { AnonDesign } from './anon-design.tsx';
import { useAnonValue } from './use-anon-value.ts';

/** The one request the page makes: a static file built at deploy. */
async function loadPreviews(): Promise<BlueprintPreviews> {
  const res = await fetch(PATHS.previews, {
    headers: { accept: 'application/json' },
    credentials: 'omit',
  });
  if (!res.ok) throw new Error('The blueprint previews did not load.');
  return (await res.json()) as BlueprintPreviews;
}

function Loaded({ data }: { data: BlueprintPreviews }) {
  const { authed } = useSession();
  const { s, value } = useAnonValue(data, Boolean(authed));
  return (
    <AnonProvider value={value}>
      {s.missing ? (
        <Callout className="mb-3" tone="info">
          {WB_DESIGN.anon.badLink(s.missing)}
        </Callout>
      ) : null}
      <AnonDesign blueprint={s.current} />
    </AnonProvider>
  );
}

/** Design for a signed-out visitor (design §1.9): a blueprint in the designer core, read only, with its sample as data. */
export function AnonPage() {
  const previews = useQuery({
    queryKey: ['workbench', 'anon-previews'],
    queryFn: loadPreviews,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return (
    <ToolPage tool="design">
      <div className="wb-tool-playground">
        {previews.data ? (
          <Loaded data={previews.data} />
        ) : previews.isError ? (
          <ToolFailed error={previews.error} onRetry={() => void previews.refetch()} />
        ) : (
          <DesignerSkeleton />
        )}
      </div>
    </ToolPage>
  );
}
