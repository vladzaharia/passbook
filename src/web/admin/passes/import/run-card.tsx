import { Check } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { cn } from '../../../lib/cn.ts';
import { Buddy, Card, CardBody, Celebrate, CountUp, ProgressBar } from '../../../ui/index.ts';

/** About how long is left, from the rate so far; nothing until there is a rate to go by. */
function timeLeft(done: number, total: number, since: number | null, now: number): string | null {
  if (!since || done < 1 || now - since < 3000) return null;
  const mins = Math.ceil(((total - done) * ((now - since) / done)) / 60_000);
  return C.run.left(Math.max(1, mins));
}

/** A running import: the foil bar with the buddy riding it. The page polls; the bar moves to match. */
export function RunningCard({ imp }: { imp: PassImportDto }) {
  const total = (imp.counts?.create ?? 0) + (imp.counts?.update ?? 0);
  const done = Math.min(imp.progress?.done ?? 0, total);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);
  const left = timeLeft(done, total, imp.committedAt, now);
  const text = C.progressText(done, total);
  const share = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <Card>
      <CardBody className="flex flex-col gap-5 p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p aria-live="polite" className="text-base font-semibold tabular-nums text-fg-strong">
            {text}
            {left ? <span className="font-normal text-fg-muted"> · {left}</span> : null}
          </p>
          <p className="text-sm text-fg-muted">{C.run.leave}</p>
        </div>
        <div data-art-host="" className="wl-buddy-room relative [--wl-buddy-room:3.5rem]">
          <span
            aria-hidden
            className="absolute top-0 h-1.5 w-0 motion-safe:transition-[left] motion-safe:duration-(--wl-dur-enter) motion-safe:ease-(--wl-ease-move)"
            style={{ left: `${share * 100}%` }}
          >
            <Buddy scene="count" size="sm" />
          </span>
          <ProgressBar
            label="Passes handled"
            value={done}
            max={Math.max(total, 1)}
            valueText={text}
            tone="foil"
          />
        </div>
        <Counters imp={imp} />
      </CardBody>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'danger' }) {
  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <dd
        className={cn(
          'text-2xl font-semibold text-fg-strong',
          tone === 'danger' && value > 0 && 'text-danger',
        )}
      >
        <CountUp value={value} />
      </dd>
      <dt className="text-xs text-fg-muted">{label}</dt>
    </div>
  );
}

/** Created, Updated, Failed and Skipped; the skipped are the rows the check refused. */
export function Counters({ imp }: { imp: PassImportDto }) {
  const p = imp.progress;
  const skipped = (imp.counts?.errors ?? 0) + (p?.skipped ?? 0);
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label={C.results.created} value={p?.created ?? 0} />
      <Stat label={C.results.updated} value={p?.updated ?? 0} />
      <Stat label={C.results.failed} value={p?.failed ?? 0} tone="danger" />
      <Stat label={C.results.skipped} value={skipped} />
    </dl>
  );
}

/** A finished import: the buddy cheers once on a clean run, and looks sorry on a failed one. */
export function DoneCard({
  imp,
  undone,
  children,
}: {
  imp: PassImportDto;
  undone: boolean;
  children: ReactNode;
}) {
  const p = imp.progress;
  const skipped = (imp.counts?.errors ?? 0) + (p?.skipped ?? 0);
  const clean = imp.state === 'done' && (p?.failed ?? 0) === 0 && skipped === 0 && !undone;
  const total = (p?.created ?? 0) + (p?.updated ?? 0) + (p?.unchanged ?? 0);
  const celebrated = useRef(clean);
  return (
    <Card data-art-host="" className="wl-buddy-room relative">
      <Buddy
        scene={undone ? 'peek' : clean ? 'cheer' : 'sorry'}
        mood={undone || clean ? 'happy' : 'sad'}
        size="sm"
      />
      <Celebrate when={celebrated.current} />
      <CardBody className="flex flex-col gap-5 p-6">
        <p className="flex items-center gap-2 text-base font-semibold text-fg-strong">
          <span className="wl-step-done inline-flex size-6 items-center justify-center rounded-full bg-success text-accent-on">
            <Check aria-hidden className="size-4" />
          </span>
          {imp.state === 'failed' ? C.results.stopped : undone ? C.undo.undone : C.run.done(total)}
        </p>
        <Counters imp={imp} />
        {children}
      </CardBody>
    </Card>
  );
}
