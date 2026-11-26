import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { StatusPill } from '@/web/ui/index.ts';
import { RunSteps, stepIndex } from '../../brand/run-steps.tsx';
import { useSetupRun } from './platform-queries.ts';

const LABELS = PASS_SETUP_COPY.channelsCard.runSteps;

/** A platform setup run, live: the steps tick as Apple answers, and a wait or failure says so. */
export function PlatformRun({ runId }: { runId: string }) {
  const run = useSetupRun(runId).data;
  if (!run) return null;
  const failed = run.state === 'failed' || run.state === 'cancelled';
  const done = run.state === 'succeeded';
  return (
    <div className="flex flex-col gap-3">
      <RunSteps labels={LABELS} at={done ? LABELS.length : stepIndex(run.step)} failed={failed} />
      {run.state === 'waiting' ? <StatusPill status="queued">Waiting on Apple</StatusPill> : null}
      {failed && run.errorCode ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {run.errorCode}
        </p>
      ) : null}
    </div>
  );
}
