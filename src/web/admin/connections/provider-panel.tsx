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
import type { SetupTopic } from '../../ui/webhook-setup/types.ts';

type Detail = z.infer<typeof ConnectionDetailSchema>;
type State = Parameters<NonNullable<ListenProps['onChange']>>[0];

/** PassBook's side, beside the guide: the URL, the topics ticking as deliveries name them, the live check. */
export function ProviderPanel({
  setup,
  connection,
  load,
  zone,
  seen,
  onState,
  onFix,
  onTurnOn,
  onFailures,
}: {
  setup: ConnectionSetup;
  connection: Detail;
  load: ArrivalLoader;
  zone: string;
  seen: readonly string[];
  onState: (state: State) => void;
  /** A refused signature or a missing secret: back to the Secret step. */
  onFix: () => void;
  onTurnOn: () => void;
  onFailures: () => void;
}) {
  const topics = setup.subscriptions.topics;
  return (
    <div className="flex flex-col gap-5">
      {setup.values.endpointUrl ? (
        <CopyRow label="Endpoint URL" value={setup.values.endpointUrl} />
      ) : null}
      {topics.length > 0 ? <TopicChecklist topics={topics} seen={seen} /> : null}
      <LiveCheck
        mode="listen"
        provider={setup.recipe === 'custom' ? 'your system' : setup.provider.name}
        load={load}
        since={connection.createdAt}
        topics={topics}
        origin={setup.secret.origin}
        recipeFix={setup.troubleshooting}
        zone={zone}
        onChange={onState}
        actions={{
          replaceSecret: onFix,
          goToSecret: onFix,
          turnOnTestEvents: onTurnOn,
          openFailures: onFailures,
        }}
      />
    </div>
  );
}

/** Between 640 and 1023 the panel is one line under the stepper: the URL, and how far the wait is. */
export function ProviderStrip({
  url,
  topics,
  seen,
  verified,
}: {
  url: string;
  topics: readonly SetupTopic[];
  seen: readonly string[];
  verified: boolean;
}) {
  const progress = topicProgress(topics, seen);
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{url}</span>
      <CopyButton value={url} label="Copy endpoint URL" />
      <span className="shrink-0 text-fg-muted">
        {verified
          ? 'Signed delivery seen'
          : progress.of > 0
            ? `Listening · ${progress.seen} of ${progress.of} seen`
            : 'Listening'}
      </span>
    </span>
  );
}
