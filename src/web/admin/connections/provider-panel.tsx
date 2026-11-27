import type { z } from 'zod';
import type { ConnectionSetup } from '@/shared/contracts/connection-setup.ts';
import type { ConnectionDetailSchema } from '@/shared/contracts/connections.ts';
import { CopyButton } from '../../ui/index.ts';
import {
  type ArrivalLoader,
  CopyRow,
  type ListenProps,
  LiveCheck,
  TopicChecklist,
  topicProgress,
} from '../../ui/webhook-setup/index.ts';
import { LISTENING } from '../../ui/webhook-setup/listen-state.ts';
import type { SetupTopic } from '../../ui/webhook-setup/types.ts';
import { recordNoun } from './setup-api.ts';

type Detail = z.infer<typeof ConnectionDetailSchema>;
type State = Parameters<NonNullable<ListenProps['onChange']>>[0];

/** "your system" mid-sentence; the kit capitalises where a line starts with it. */
export const providerWords = (setup: ConnectionSetup) =>
  setup.recipe === 'custom' ? 'your system' : setup.provider.name;

/** The live check: waiting on what PassBook sees arrive. On the Test step it leads the page. */
export function ProviderLive({
  setup,
  connection,
  load,
  zone,
  notIssued,
  onState,
  actions,
}: {
  setup: ConnectionSetup;
  connection: Pick<Detail, 'createdAt'>;
  load: ArrivalLoader;
  zone: string;
  notIssued?: ReadonlySet<string> | undefined;
  onState: (state: State) => void;
  actions: NonNullable<ListenProps['actions']>;
}) {
  const provider = providerWords(setup);
  return (
    <LiveCheck
      mode="listen"
      provider={provider}
      load={load}
      since={connection.createdAt}
      topics={setup.subscriptions.topics}
      origin={setup.secret.origin}
      recipeFix={setup.troubleshooting}
      record={recordNoun(setup.recipe)}
      notIssued={notIssued}
      zone={zone}
      onChange={onState}
      actions={actions}
    />
  );
}

/** PassBook's side, beside the guide: the URL, the topics ticking as deliveries name them, and the live check unless it leads the page. */
export function ProviderPanel({
  setup,
  seen,
  live,
}: {
  setup: ConnectionSetup;
  seen: readonly string[];
  live: React.ReactNode;
}) {
  const topics = setup.subscriptions.topics;
  return (
    <>
      {setup.values.endpointUrl ? (
        <CopyRow label="Endpoint URL" value={setup.values.endpointUrl} />
      ) : null}
      {topics.length > 0 ? <TopicChecklist topics={topics} seen={seen} /> : null}
      {live}
    </>
  );
}

/** Between 640 and 1023 the panel is one line under the stepper: the URL, and how far the wait is. */
export function ProviderStrip({
  url,
  topics,
  seen,
  verified,
  head,
}: {
  url: string;
  topics: readonly SetupTopic[];
  seen: readonly string[];
  verified: boolean;
  /** The live panel's heading, said here too while it is not the plain wait. */
  head?: string | undefined;
}) {
  const progress = topicProgress(topics, seen);
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{url}</span>
      <CopyButton value={url} label="Copy endpoint URL" />
      <span className="shrink-0 text-fg-muted">
        {verified
          ? 'Signed delivery seen'
          : head && head !== LISTENING
            ? head
            : progress.of > 0
              ? `Listening · ${progress.seen} of ${progress.of} seen`
              : 'Listening'}
      </span>
    </span>
  );
}
