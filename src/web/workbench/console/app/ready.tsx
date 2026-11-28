import { useEffect, useState } from 'react';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import { BenchSkeleton } from '../../bench/skeleton.tsx';
import type { ConsoleClient } from '../client.ts';
import { loadFile } from '../data.ts';
import type { Launch } from '../launch.ts';
import { takesTemplate } from '../request.ts';
import { firstTemplateId } from '../template-sample.ts';
import type { RunOp } from '../types.ts';
import { OpConsole } from './console.tsx';
import { LazyFailed } from './lazy-state.tsx';
import { type LogRead, useFill } from './use-launch.ts';

const NO_LAUNCH: Launch = { op: null, sample: null, from: null, prefill: null };

type Loaded = { op: RunOp; origin: string } | 'missing' | null;

function useOp(slug: string | undefined, id: string | undefined): Loaded {
  const [state, setState] = useState<Loaded>(null);
  useEffect(() => {
    setState(null);
    if (!slug || !id) return;
    let live = true;
    loadFile(slug).then(
      (f) => {
        const op = f.ops.find((o) => o.id === id);
        if (live) setState(op ? { op, origin: f.origin } : 'missing');
      },
      () => live && setState('missing'),
    );
    return () => {
      live = false;
    };
  }, [slug, id]);
  return state;
}

/** The org's first template, read once an operation needs one: undefined while it is read, null when there is none or none is needed. */
function useFirstTemplate(client: ConsoleClient, needed: boolean): string | null | undefined {
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!needed || !client.orgId) return;
    let live = true;
    void firstTemplateId(client.orgId, client.send).then((got) => live && setId(got));
    return () => {
      live = false;
    };
  }, [client, needed]);
  return needed && client.orgId ? id : null;
}

/** One operation: its file is read, then the console for it. */
export function Ready({
  client,
  templateId,
  mode,
  slug,
  opId,
  codes,
  launch,
  log,
  reason,
}: {
  client: ConsoleClient;
  /** The template examples name: the sandbox's. Undefined: the org's first one is looked up. */
  templateId?: string | null | undefined;
  mode: 'op' | 'console' | 'sheet';
  slug?: string | undefined;
  opId?: string | undefined;
  codes: ReadonlySet<string>;
  /** The Console's address: what filled the request, and the Logs row it read. */
  launch?: Launch | undefined;
  log?: LogRead | undefined;
  reason?: string | null | undefined;
}) {
  const loaded = useOp(slug, opId);
  const lookup =
    templateId === undefined && loaded !== null && loaded !== 'missing' && takesTemplate(loaded.op);
  const found = useFirstTemplate(client, lookup);
  const fill = useFill(
    loaded !== null && loaded !== 'missing' ? loaded.op : null,
    launch ?? NO_LAUNCH,
    log ?? { state: 'none' },
  );
  if (loaded === 'missing')
    return <LazyFailed reason={CONSOLE_COPY.loadFailed} onRetry={() => location.reload()} />;
  // A Logs row is read before the form is drawn: it starts from what that call sent.
  if (!loaded || found === undefined || log?.state === 'loading') return <BenchSkeleton rows={3} />;
  return (
    <OpConsole
      key={loaded.op.id}
      op={loaded.op}
      origin={loaded.origin}
      client={client}
      templateId={templateId === undefined ? found : templateId}
      codes={codes}
      mode={mode}
      prefill={fill.prefill ?? undefined}
      note={fill.note}
      reason={reason}
    />
  );
}
