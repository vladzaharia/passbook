import { type ReactNode, useEffect, useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Card, CardBody } from '../../../ui/index.ts';
import { RunDone, RunProgress, RunStats } from '../run-kit.tsx';

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
  return (
    <Card>
      <CardBody className="flex flex-col gap-5 p-6">
        <RunProgress
          done={done}
          total={total}
          text={text}
          meta={left}
          aside={<p className="text-sm text-fg-muted">{C.run.leave}</p>}
        />
        <Counters imp={imp} />
      </CardBody>
    </Card>
  );
}

/** Created, Updated, Failed and Skipped; the skipped are the rows the check refused. */
export function Counters({ imp }: { imp: PassImportDto }) {
  const p = imp.progress;
  const skipped = (imp.counts?.errors ?? 0) + (p?.skipped ?? 0);
  return (
    <RunStats
      stats={[
        { label: C.results.created, value: p?.created ?? 0 },
        { label: C.results.updated, value: p?.updated ?? 0 },
        { label: C.results.failed, value: p?.failed ?? 0, tone: 'danger' },
        { label: C.results.skipped, value: skipped },
      ]}
    />
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
  return (
    <RunDone
      clean={clean}
      undone={undone}
      title={
        imp.state === 'failed' ? C.results.stopped : undone ? C.undo.undone : C.run.done(total)
      }
    >
      <Counters imp={imp} />
      {children}
    </RunDone>
  );
}
