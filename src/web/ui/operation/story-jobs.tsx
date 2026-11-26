import { PRINT_COPY } from '../../../shared/copy/print.ts';
import type { OperationKindDef } from '../../../shared/operations/define.ts';
import { channelCodes } from '../../../shared/operations/kinds/channel-codes.ts';
import { connectionSync } from '../../../shared/operations/kinds/connection-sync.ts';
import { orgExport } from '../../../shared/operations/kinds/org-export.ts';
import { passesReissue } from '../../../shared/operations/kinds/passes-reissue.ts';
import { printsBulk } from '../../../shared/operations/kinds/prints-bulk.ts';
import { walletReissue } from '../../../shared/operations/kinds/wallet-reissue.ts';
import { fixtureOperation, NOW } from './fixtures.test-support.ts';
import type { LocalOperationDef } from './local.ts';
import { OperationProgress } from './operation-progress.tsx';
import type { Operation } from './types.ts';

const noop = () => undefined;
const def = (k: OperationKindDef): LocalOperationDef => ({
  kind: k.kind,
  title: k.title,
  doneTitle: k.doneTitle,
  failTitle: k.failTitle,
  steps: k.steps.map((s) => ({
    key: s.key,
    label: s.label,
    ...(s.active ? { active: s.active } : {}),
  })),
});

/** What each silent job shows: mid-run with its count, done, and failed with Retry. */
const JOBS: {
  kind: OperationKindDef;
  at: string;
  done: number;
  total: number;
  note: string;
  fail: string;
}[] = [
  {
    kind: connectionSync,
    at: 'records',
    done: 120,
    total: 0,
    note: '412 records read, 3 new, 9 changed.',
    fail: 'CONNECTION_SYNC_FAILED',
  },
  {
    kind: passesReissue,
    at: 'passes',
    done: 300,
    total: 0,
    note: '298 passes rebuilt, 2 unchanged.',
    fail: 'BULK_REISSUE_FAILED',
  },
  {
    kind: walletReissue,
    at: 'copies',
    done: 40,
    total: 120,
    note: '118 passes updated, 2 skipped.',
    fail: 'OPERATION_STALLED',
  },
  {
    kind: printsBulk,
    at: 'pages',
    done: 12,
    total: 40,
    note: PRINT_COPY.bulkReady('40 tickets', false, 2, ''),
    fail: 'PRINT_BULK_VOIDED',
  },
  {
    kind: channelCodes,
    at: 'codes',
    done: 7,
    total: 20,
    note: '20 codes replaced.',
    fail: 'OPERATION_STALLED',
  },
  {
    kind: orgExport,
    at: 'rows',
    done: 4,
    total: 9,
    note: 'The archive stays until Dec 2.',
    fail: 'ORG_EXPORT_FAILED',
  },
];

function rebase(op: Operation): Operation {
  const d = Date.now() - NOW;
  const at = (t: number | null) => (t === null ? null : t + d);
  return {
    ...op,
    startedAt: at(op.startedAt),
    finishedAt: at(op.finishedAt),
    steps: op.steps.map((s) => ({
      ...s,
      startedAt: at(s.startedAt),
      finishedAt: at(s.finishedAt),
    })),
  };
}

/** The silent jobs on one page, for the shots (tools/dev/operation-story/jobs.html). Dev only. */
export function JobsStory() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 p-4 sm:p-8">
      {JOBS.map((j) => {
        const d = def(j.kind);
        const counts =
          j.total > 0
            ? { counts: { done: j.done, total: j.total } }
            : { counts: { done: j.done, total: 0 } };
        const running = fixtureOperation(d, {
          status: 'running',
          at: j.at,
          ...(j.total > 0 ? counts : {}),
        });
        if (j.total === 0)
          running.steps = running.steps.map((s) => (s.key === j.at ? { ...s, done: j.done } : s));
        if (j.total === 0)
          running.text = `${d.steps.find((s) => s.key === j.at)?.active} · ${j.done}`;
        const ok = fixtureOperation(d, { status: 'succeeded' });
        const bad = fixtureOperation(d, { status: 'failed', at: j.at });
        const message = j.kind.errors?.[j.fail] ?? '';
        const failed: Operation = {
          ...bad,
          error: { code: j.fail, message, step: j.at, retryable: j.kind.retry },
        };
        return (
          <section
            key={j.kind.kind}
            aria-label={j.kind.title}
            className="grid gap-4 md:grid-cols-3"
          >
            {[running, ok, failed].map((op) => (
              <div
                key={op.status}
                className="w-full rounded-xl border border-border bg-surface-overlay p-5 shadow-elevation-3"
              >
                <OperationProgress
                  operation={rebase(op)}
                  zone="America/Los_Angeles"
                  onRetry={noop}
                  onClose={noop}
                  {...(op.status === 'succeeded' ? { doneNote: j.note } : {})}
                />
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
