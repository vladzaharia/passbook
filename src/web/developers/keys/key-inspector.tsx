import { ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import type { DeveloperHomeKey } from '../../../shared/contracts/developer-home.ts';
import { BENCH_KEYS_COPY as C } from '../../../shared/copy/developers-bench-keys.ts';
import { PATHS } from '../../../shared/developers.ts';
import { IdChip } from '../bench/id-chip.tsx';
import { Inspector } from '../bench/inspector.tsx';
import { loadRail } from '../bench/rail.ts';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { Trace, traceNodes } from '../bench/trace.tsx';
import type { Method } from '../model/types.ts';
import { MethodPill } from '../ui/method-pill.tsx';
import { keyState, masked, sparkPoints } from '../workbench/model.ts';
import { type KeyCalls, useKeyCalls } from './calls.ts';
import { accessOf, STATE_TONE } from './model.ts';
import './key-inspector.css';

type Rail = Awaited<ReturnType<typeof loadRail>>['body'];

/** The sandbox key's rate tier and the last hour: the facts "Your API" gave the log. */
function useRail(isSandboxKey: boolean, keyId: string): Rail {
  const [rail, setRail] = useState<Rail>(null);
  useEffect(() => {
    if (!isSandboxKey) return;
    let live = true;
    void loadRail().then(({ body }) => live && setRail(body?.key?.id === keyId ? body : null));
    return () => {
      live = false;
    };
  }, [isSandboxKey, keyId]);
  return isSandboxKey ? rail : null;
}

const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="ksi-fact">
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

function Spark({ values }: { values: readonly number[] }) {
  const w = 96;
  const h = 24;
  return (
    <svg
      className="ksi-spark"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline points={sparkPoints(values, w, h)} />
    </svg>
  );
}

function Recent({ calls, now }: { calls: KeyCalls; now: number }) {
  if (calls.state === 'loading') return <BenchSkeleton rows={2} />;
  if (calls.state === 'failed')
    return (
      <p className="sm muted">
        {C.recent.failed}{' '}
        <button type="button" className="btn sm ghost" onClick={calls.retry}>
          Retry
        </button>
      </p>
    );
  if (calls.items.length === 0) return <p className="sm muted">{C.recent.none}</p>;
  return (
    <ul className="ksi-calls">
      {calls.items.map((c) => (
        <li key={c.id}>
          <a className="ksi-call" href={`${PATHS.logs}#${encodeURIComponent(c.id)}`}>
            <MethodPill method={c.method.toLowerCase() as Method} />
            <span className="ksi-path">{c.path}</span>
            <StatusChip status={c.status} />
            <BenchTime at={c.at} now={now} />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** A key: its access, expiry and use at a glance, its last five calls, Roll and Revoke. */
export function KeyInspector({
  k,
  now,
  onRoll,
  onRevoke,
  onPrev,
  onNext,
}: {
  k: DeveloperHomeKey;
  now: number;
  onRoll: () => void;
  onRevoke: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const state = keyState(k, now);
  const calls = useKeyCalls(k.id);
  const rail = useRail(k.sandboxKey, k.id);
  const last: RequestLogEntry | undefined = calls.state === 'ready' ? calls.items[0] : undefined;
  return (
    <Inspector
      title={k.name}
      label={C.inspector(k.name)}
      itemKey={k.id}
      status={<StatusChip tone={STATE_TONE[state]}>{C.state[state]}</StatusChip>}
      id={<IdChip id={k.id} kind="key" />}
      actions={
        <>
          {state === 'active' ? (
            <button type="button" className="btn sm" onClick={onRoll}>
              {C.roll}
            </button>
          ) : null}
          <button type="button" className="btn sm danger" onClick={onRevoke}>
            {C.revoke}
          </button>
        </>
      }
      onPrev={onPrev}
      onNext={onNext}
      trace={
        <Trace
          nodes={traceNodes({
            key: { id: k.id, name: k.name, prefix: k.secretPrefix },
            request: last
              ? { id: last.id, method: last.method, path: last.path, status: last.status }
              : null,
          })}
        />
      }
    >
      <dl className="ksi-facts">
        <Fact label={C.facts.access}>{accessOf(k)}</Fact>
        <Fact label={C.facts.secret}>
          <code>{masked(k)}</code>
        </Fact>
        <Fact label={C.facts.expires}>
          {k.expiresAt === null ? (
            C.never
          ) : (
            <>
              <BenchTime at={k.expiresAt} mode="full" />
              <BenchTime at={k.expiresAt} mode="until" now={now} className="muted" />
            </>
          )}
        </Fact>
        {k.retireAt !== null ? (
          <Fact label={C.facts.stops}>
            <BenchTime at={k.retireAt} mode="full" />
          </Fact>
        ) : null}
        <Fact label={C.facts.used}>
          {k.lastUsedAt === null ? C.never : <BenchTime at={k.lastUsedAt} mode="ago" now={now} />}
        </Fact>
        <Fact label={C.facts.created}>
          <BenchTime at={k.createdAt} mode="full" />
        </Fact>
        {rail ? (
          <>
            <Fact label={C.facts.rate}>{C.facts.perMinute(rail.limitPerMinute, rail.tier)}</Fact>
            <Fact label={C.facts.hour}>
              {C.facts.calls(rail.callsLastHour)}
              <Spark values={rail.series ?? []} />
            </Fact>
          </>
        ) : null}
      </dl>
      <details className="ksi-sec ksi-more" open={k.scopes.length <= 6}>
        <summary className="ksi-h">
          {C.facts.scopes(k.scopes.length)}
          <ChevronDown aria-hidden="true" />
        </summary>
        <ul className="ksi-scopes">
          {k.scopes.map((s) => (
            <li key={s}>
              <code className="chip mono">{s}</code>
            </li>
          ))}
        </ul>
      </details>
      <section className="ksi-sec" aria-labelledby={`ksi-r-${k.id}`}>
        <div className="ksi-rh">
          <h3 className="ksi-h" id={`ksi-r-${k.id}`}>
            {C.recent.title}
          </h3>
          <a className="btn sm outline" href={`${PATHS.logs}?key=${encodeURIComponent(k.id)}`}>
            {C.recent.all}
          </a>
        </div>
        <Recent calls={calls} now={now} />
      </section>
    </Inspector>
  );
}
