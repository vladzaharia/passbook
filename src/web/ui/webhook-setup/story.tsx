import { useMemo, useState } from 'react';
import { Wizard } from '../wizard.tsx';
import {
  CopyRow,
  LiveCheck,
  RotateSecretForm,
  SetupSources,
  SetupSteps,
  TopicChecklist,
  TwoSided,
  useRotateSecret,
  VerifyGuide,
} from './index.ts';
import { arrival, STEPS, TOPICS, URL_VALUE } from './test-support.test-support.tsx';
import type { Arrival, SendResult } from './types.ts';

export const STORY_STATES = [
  'all',
  'wizard',
  'listening',
  'signed',
  'sample',
  'ignored',
  'rejected',
  'slow',
  'paused',
  'error',
  'send',
  'send-ok',
  'send-fail',
  'verify',
  'rotate',
] as const;
export type StoryState = (typeof STORY_STATES)[number];

const ZONE = 'America/Los_Angeles';
const rows = (state: StoryState): Arrival[] =>
  state === 'signed'
    ? [arrival({ topic: 'orders/create' })]
    : state === 'sample'
      ? [arrival({ outcome: 'ignored', reason: 'stale', topic: 'orders/create' })]
      : state === 'ignored'
        ? [arrival({ outcome: 'ignored', reason: 'unknown_type', topic: 'other' })]
        : state === 'rejected'
          ? [arrival({ outcome: 'rejected', reason: 'signature_mismatch', topic: null, count: 2 })]
          : [];

const FIX = { none: 'Check the webhook is listed. Shopify deletes ones that keep failing.' };

function Listen({ state, buddy }: { state: StoryState; buddy?: boolean }) {
  const load = useMemo(
    () => async () => {
      if (state === 'error') throw new Error('The ledger is not reachable.');
      return { rows: rows(state), etag: state };
    },
    [state],
  );
  const marks =
    state === 'slow'
      ? { slowMs: 10 }
      : state === 'paused'
        ? { slowMs: 10, pauseMs: 60 }
        : undefined;
  return (
    <LiveCheck
      mode="listen"
      provider="Shopify"
      load={load}
      since={0}
      topics={TOPICS}
      recipeFix={FIX}
      zone={ZONE}
      buddy={buddy}
      {...(marks ? { marks } : {})}
      hint="In Shopify: row menu › Send test."
      actions={{ replaceSecret: () => undefined, turnOnTestEvents: () => undefined }}
      onInspect={() => undefined}
    />
  );
}

const OK: SendResult = { ok: true, status: 200, durationMs: 140 };
function Send({ state }: { state: StoryState }) {
  const send = useMemo(
    () => async () =>
      state === 'send-fail'
        ? { ok: false, status: 502, durationMs: 88, requestId: 'req_01JD4F8Z' }
        : OK,
    [state],
  );
  const [auto, setAuto] = useState(false);
  return (
    <div
      ref={(el) => {
        if (el && !auto && state !== 'send') {
          setAuto(true);
          queueMicrotask(() => el.querySelector<HTMLButtonElement>('button')?.click());
        }
      }}
    >
      <LiveCheck
        mode="send"
        send={send}
        host="api.example.com"
        hint="PassBook posts a signed sample event."
      />
    </div>
  );
}

function Rotate() {
  const state = useRotateSecret(async () => ({ secret: 'whsec_4f1c0b7a9e2d4c58a31b' }));
  return (
    <div className="flex max-w-md flex-col gap-4 rounded-xl border border-border bg-surface-overlay p-5">
      <RotateSecretForm state={state} onDone={() => undefined} />
      <button type="submit" form={state.formId} className="self-start text-sm underline">
        Rotate
      </button>
    </div>
  );
}

const WIZARD_STEPS = [
  ...['Source', 'Setup', 'Mapping', 'Issuing', 'Review'].map((title, i) => ({
    id: `p${i}`,
    title,
    group: 'In PassBook',
    locked: true,
    summary: i === 0 ? 'Shopify orders' : undefined,
  })),
  { id: 'connect', title: 'Connect', heading: 'Add the webhook', group: 'In Shopify' },
  { id: 'secret', title: 'Secret', group: 'In Shopify' },
  { id: 'test', title: 'Test', group: 'In Shopify' },
];

function WizardStory() {
  const [seen, setSeen] = useState<string[]>([]);
  const guide = (
    <div className="flex flex-col gap-6">
      <SetupSteps steps={STEPS} values={{ endpointUrl: URL_VALUE }} topics={TOPICS} />
      <SetupSources
        provider="Shopify"
        consoleUrl={null}
        docs={[
          {
            label: 'Shopify Help',
            url: 'https://help.shopify.com/en/manual/orders/notifications/webhooks',
          },
        ]}
        checkedAt="2026-11-25"
      />
    </div>
  );
  const panel = (
    <div className="flex flex-col gap-5">
      <CopyRow label="Endpoint URL" value={URL_VALUE} />
      <TopicChecklist topics={TOPICS} seen={seen} />
      <LiveCheck
        mode="listen"
        provider="Shopify"
        load={async () => ({ rows: [], etag: 'x' })}
        since={0}
        topics={TOPICS}
        zone={ZONE}
        onChange={(s) => setSeen(s.seen)}
      />
    </div>
  );
  return (
    <Wizard
      steps={WIZARD_STEPS}
      current={5}
      onStep={() => undefined}
      lockedReason="Change this on the connection."
      onCancel={() => undefined}
      onBack={() => undefined}
      onNext={() => undefined}
      nextLabel="Next"
    >
      <TwoSided
        guide={guide}
        panel={panel}
        strip={
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{URL_VALUE}</span>
            <span className="shrink-0 text-fg-muted">Listening · 0 of 2 seen</span>
          </span>
        }
      />
    </Wizard>
  );
}

const SHEET: readonly [StoryState, string][] = [
  ['listening', 'Listening, nothing yet'],
  ['signed', 'Signed, accepted'],
  ['sample', 'Signed, sample'],
  ['ignored', 'Signed, ignored'],
  ['rejected', 'Rejected'],
  ['slow', '3 min, nothing'],
  ['paused', 'Paused'],
  ['error', 'Ledger error'],
  ['send', 'Send, idle'],
  ['send-ok', 'Send, delivered'],
  ['send-fail', 'Send, failed'],
];

function Sheet() {
  return (
    <main className="grid grid-cols-1 gap-x-8 gap-y-14 p-4 pt-16 md:grid-cols-2 xl:grid-cols-3 sm:p-8 sm:pt-16">
      {SHEET.map(([state, label]) => (
        <section key={state} aria-label={label} className="min-w-0">
          <p className="mb-2 text-xs font-medium text-fg-muted">{label}</p>
          {state.startsWith('send') ? <Send state={state} /> : <Listen state={state} />}
        </section>
      ))}
      <section aria-label="Parts" className="flex min-w-0 flex-col gap-5">
        <p className="text-xs font-medium text-fg-muted">Copy row and topics</p>
        <CopyRow label="Endpoint URL" value={URL_VALUE} />
        <TopicChecklist topics={TOPICS} seen={['orders/create']} />
      </section>
      <section aria-label="Verify" className="min-w-0 md:col-span-2">
        <p className="mb-2 text-xs font-medium text-fg-muted">Verify guide</p>
        <VerifyGuide url="https://api.example.com/passbook" />
      </section>
      <section aria-label="Rotate" className="min-w-0">
        <p className="mb-2 text-xs font-medium text-fg-muted">Rotate secret</p>
        <Rotate />
      </section>
    </main>
  );
}

/** Every state of the webhook-setup kit, for the story page (tools/dev/webhook-setup-story). */
export function WebhookSetupStory({ state }: { state: StoryState }) {
  if (state === 'all') return <Sheet />;
  if (state === 'wizard')
    return (
      <main className="p-4 sm:p-8">
        <WizardStory />
      </main>
    );
  const body =
    state === 'verify' ? (
      <VerifyGuide url="https://api.example.com/passbook" />
    ) : state === 'rotate' ? (
      <Rotate />
    ) : state.startsWith('send') ? (
      <Send state={state} />
    ) : (
      <Listen state={state} />
    );
  return <main className="mx-auto w-full max-w-md p-4 pt-16 sm:p-8 sm:pt-16">{body}</main>;
}
