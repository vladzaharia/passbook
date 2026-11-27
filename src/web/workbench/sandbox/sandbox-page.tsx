import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { WB_SANDBOX_COPY } from '@/shared/copy/workbench-sandbox.ts';
import { cn } from '../../lib/cn.ts';
import { Button } from '../../ui/button.tsx';
import { CARD_SURFACE } from '../../ui/card-base.tsx';
import {
  createFetchClient,
  OperationProgress,
  OperationsProvider,
  useOperation,
  useOperationActions,
} from '../../ui/operation/index.ts';
import { mintKey } from '../console/sandbox-actions.ts';
import type { Sandbox } from '../console/session.ts';
import { fetchHome } from '../home/api.ts';
import { dropToken } from '../host/token.ts';
import { useToolHost } from '../host/tool-host.tsx';
import { useSandboxBusy } from './busy.ts';
import { KeyReveal } from './key-reveal.tsx';
import { type Act, RESUME_KEY } from './lifecycle.ts';

const Danger = lazy(() => import('./danger.tsx'));

const C = WB_SANDBOX_COPY;
const QUOTA_ORDER = ['passes', 'templates', 'endpoints', 'keys'] as const;

const resumed = (): Act | null => {
  try {
    const v = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);
    return v === 'reset' || v === 'start-over' || v === 'delete' ? v : null;
  } catch {
    return null;
  }
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono text-[0.8125rem] text-fg-strong">
        {children}
      </dd>
    </div>
  );
}

/** What a sandbox holds against its plan's caps: the person's own home read, which the server keeps to the session. */
function Limits({ orgId }: { orgId: string }) {
  const { data } = useQuery({
    queryKey: ['workbench', 'sandbox', orgId],
    queryFn: () => fetchHome(),
  });
  const quotas = data?.quotas;
  if (!quotas) return null;
  return (
    <section className={cn('p-4', CARD_SURFACE)} aria-labelledby="wb-sandbox-limits">
      <h2 id="wb-sandbox-limits" className="mb-3 text-sm font-semibold text-fg-strong">
        {C.limits}
      </h2>
      <dl className="divide-y divide-border border-t border-border pt-0 [&>div:first-child]:pt-2">
        {QUOTA_ORDER.map((key) => {
          const { used, limit } = quotas[key];
          return (
            <Row key={key} label={C.limitLabels[key]}>
              {limit === null ? `${used} · ${C.unlimited}` : `${used} of ${limit}`}
            </Row>
          );
        })}
      </dl>
    </section>
  );
}

/** The operation under way, live: every step, Retry on the one that failed. A reset hands its new key over once. */
function Running({ id, csrf, onClose }: { id: string; csrf: string; onClose: () => void }) {
  const { operation } = useOperation(id);
  const { retry, retrying } = useOperationActions();
  const { context } = useToolHost();
  const [secret, setSecret] = useState<string | null>(null);
  const told = useRef<string | null>(null);
  const done = operation?.status === 'succeeded' ? operation : null;
  useEffect(() => {
    if (done?.kind !== 'sandbox.reset' || told.current === done.id) return;
    told.current = done.id;
    dropToken(context.orgId);
    void mintKey(csrf).then(setSecret, () => undefined);
  }, [done, csrf, context.orgId]);
  if (!operation) return null;
  return (
    <div className="flex flex-col gap-3">
      <OperationProgress
        operation={operation}
        framing="card"
        onRetry={() => void retry(operation)}
        retrying={retrying}
        onClose={onClose}
      />
      {secret ? <KeyReveal secret={secret} /> : null}
    </div>
  );
}

/** The Sandbox page: name, limits, and the three actions that change it. */
export function SandboxPanel({ csrf, sandbox }: { csrf: string; sandbox: Sandbox }) {
  const host = useToolHost();
  const [act, setAct] = useState<Act | null>(() => resumed());
  const [started, setStarted] = useState<string | null>(null);
  const queries = useQueryClient();
  const client = useMemo(() => createFetchClient({ csrf: async () => csrf }), [csrf]);
  const running = useSandboxBusy(sandbox.orgId, true);
  const id = running?.id ?? started;
  const quiet = running !== undefined;
  return (
    <OperationsProvider client={client}>
      <div className="flex max-w-2xl flex-col gap-4">
        {id ? <Running id={id} csrf={csrf} onClose={() => setStarted(null)} /> : null}
        <section className={cn('p-4', CARD_SURFACE)} aria-label={host.context.name}>
          <dl className="divide-y divide-border">
            <Row label={C.name}>{host.context.name}</Row>
            <Row label={C.id}>{sandbox.orgSlug}</Row>
          </dl>
        </section>
        <Limits orgId={sandbox.orgId} />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={quiet}
            iconStart={<RotateCcw aria-hidden />}
            onClick={() => setAct('reset')}
          >
            {C.reset}
          </Button>
          <Button
            variant="outline"
            disabled={quiet}
            iconStart={<RotateCcw aria-hidden />}
            onClick={() => setAct('start-over')}
          >
            {C.startOver}
          </Button>
          <Button
            variant="outline"
            className="text-danger!"
            disabled={quiet}
            iconStart={<Trash2 aria-hidden />}
            onClick={() => setAct('delete')}
          >
            {C.deleteSandbox}
          </Button>
        </div>
      </div>
      {act || started ? (
        <Suspense fallback={null}>
          <Danger
            act={act}
            followId={started}
            onDone={() => setAct(null)}
            onStarted={(opId) => {
              setStarted(opId);
              void queries.invalidateQueries({ queryKey: ['workbench', 'sandbox'] });
            }}
          />
        </Suspense>
      ) : null}
    </OperationsProvider>
  );
}
