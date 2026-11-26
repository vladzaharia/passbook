import { useMemo } from 'react';
import { Menubar } from '../layout/menubar.tsx';
import { type OperationsClient, OperationsProvider } from './client.ts';
import {
  APPLE_SETUP,
  fixtureOperation,
  NOW,
  SANDBOX_CREATE,
  SANDBOX_DELETE,
  STATE_FIXTURES,
  type StateFixture,
} from './fixtures.test-support.ts';
import { OperationProgress } from './operation-progress.tsx';
import { OperationTray } from './operation-tray.tsx';
import type { Operation } from './types.ts';

export const STORY_STATES = [
  ...(Object.keys(STATE_FIXTURES) as StateFixture[]),
  'stopping',
  'retried',
  'tray',
] as const;
export type StoryState = (typeof STORY_STATES)[number];

const noop = () => undefined;

/** The fixtures' clock is fixed; the story's elapsed time must tick from the real one. */
function rebase(op: Operation): Operation {
  const d = Date.now() - NOW;
  const at = (t: number | null) => (t === null ? null : t + d);
  return {
    ...op,
    createdAt: op.createdAt + d,
    startedAt: at(op.startedAt),
    updatedAt: op.updatedAt + d,
    finishedAt: at(op.finishedAt),
    steps: op.steps.map((s) => ({
      ...s,
      startedAt: at(s.startedAt),
      finishedAt: at(s.finishedAt),
      until: op.status === 'waiting' ? at(s.until) : s.until,
    })),
  };
}

function panel(op: Operation) {
  return (
    <div className="mx-auto w-full max-w-md rounded-xl border border-border bg-surface-overlay p-5 shadow-elevation-3">
      <OperationProgress
        operation={rebase(op)}
        zone="America/Los_Angeles"
        onStop={noop}
        onRetry={noop}
        onClose={noop}
        onBackground={op.status === 'running' ? noop : undefined}
        doneNote={op.status === 'succeeded' ? 'Data is erased by Dec 2.' : undefined}
        next={op.status === 'succeeded' ? { label: 'Create sandbox', onClick: noop } : undefined}
      />
    </div>
  );
}

/** The tray's own client: one running, one done, one failed. */
function trayClient(): OperationsClient {
  const rows: Operation[] = [
    rebase(STATE_FIXTURES.running()),
    rebase({ ...fixtureOperation(SANDBOX_CREATE, { status: 'succeeded' }), id: 'done-1' }),
    rebase({ ...fixtureOperation(APPLE_SETUP, { status: 'failed', at: 'issue' }), id: 'bad-1' }),
  ];
  return {
    get: async () => ({ operation: null, etag: null }),
    list: async () => rows,
    cancel: async () => rows[0] as Operation,
    retry: async () => rows[0] as Operation,
  };
}

/** Every state of the progress kit, for the kit story page (tools/dev/operation-story). */
export function OperationStory({ state }: { state: StoryState }) {
  const client = useMemo(trayClient, []);
  if (state === 'tray')
    return (
      <OperationsProvider client={client}>
        <Menubar
          width="console"
          brand={<span className="text-sm font-semibold text-fg-strong">PassBook</span>}
          controls={<OperationTray notify={false} />}
          account={<span className="size-8 rounded-full bg-surface-sunken" />}
        />
      </OperationsProvider>
    );
  const op =
    state === 'stopping'
      ? { ...STATE_FIXTURES.running(), cancelRequested: true }
      : state === 'retried'
        ? {
            ...fixtureOperation(SANDBOX_DELETE, {
              status: 'running',
              at: 'keys',
              counts: { done: 1, total: 2 },
            }),
            attempt: 2,
          }
        : STATE_FIXTURES[state]();
  return <main className="p-4 sm:p-8">{panel(op)}</main>;
}
