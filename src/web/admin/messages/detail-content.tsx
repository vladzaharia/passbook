import type { BroadcastDto } from '@/shared/contracts/broadcasts.ts';
import { formatDateTime } from '../../lib/format.ts';
import { Card, CardBody, CardHeader, KeyValue, MetaLink, StatusPill } from '../../ui/index.ts';
import { ModePill } from '../../ui/layout/mode-pill.tsx';
import { audienceOf, clearLabel, isQuiet, KIND_LABEL, whenLine } from './labels.ts';
import { LockScreenNotice } from './lock-screen.tsx';
import { patchRows } from './patch-view.ts';

export function MessageDetails({
  b,
  orgName,
  names,
  text,
  eventName,
}: {
  b: BroadcastDto;
  orgName: string | undefined;
  names: string[];
  text: string;
  eventName?: string | undefined;
}) {
  return (
    <Card>
      <CardHeader title="Details" />
      <CardBody>
        <KeyValue
          items={[
            { label: 'Organization', value: orgName ?? '—' },
            { label: 'Templates', value: names.join(', ') },
            { label: 'Audience', value: audienceOf(b, eventName) },
            {
              label: 'Notification',
              value:
                b.kind === 'message' && !text.trim()
                  ? 'None, clears the message'
                  : b.notify
                    ? 'Notify holders'
                    : 'None',
            },
            ...(b.clearAfter ? [{ label: 'Clears', value: clearLabel(b.clearAfter) }] : []),
            { label: 'Created', value: formatDateTime(b.createdAt) },
            ...(b.startedAt ? [{ label: 'Started', value: formatDateTime(b.startedAt) }] : []),
            ...(b.finishedAt ? [{ label: 'Finished', value: formatDateTime(b.finishedAt) }] : []),
          ]}
        />
      </CardBody>
    </Card>
  );
}

export function MessageContent({
  b,
  orgName,
  orgAccent,
  inputSchema,
  text,
}: {
  b: BroadcastDto;
  orgName: string | undefined;
  orgAccent: string | null;
  inputSchema: unknown;
  text: string;
}) {
  return b.kind === 'message' ? (
    <Card>
      <CardHeader title="Message" />
      <CardBody>
        <LockScreenNotice
          org={{
            id: b.orgId,
            name: orgName ?? 'Your organization',
            accent: orgAccent,
          }}
          text={text}
          silent={isQuiet(b)}
        />
      </CardBody>
    </Card>
  ) : (
    <Card>
      <CardHeader title="Changes" />
      <CardBody>
        <KeyValue
          items={patchRows(inputSchema, b.patch).map((r) => ({
            label: r.label,
            value: r.value,
          }))}
        />
      </CardBody>
    </Card>
  );
}

/** Mode, state, kind and links to the related messages. */
export function MessageMeta({ b }: { b: BroadcastDto }) {
  return (
    <>
      <ModePill mode={b.mode} />
      <StatusPill status={b.state}>{b.state === 'sent' ? 'Completed' : undefined}</StatusPill>
      <span>{KIND_LABEL[b.kind]}</span>
      <span>{whenLine(b)}</span>
      {b.parentId ? (
        <MetaLink to="/admin/messages/$broadcastId" params={{ broadcastId: b.parentId }}>
          Original message
        </MetaLink>
      ) : null}
      {b.followUp ? (
        <MetaLink to="/admin/messages/$broadcastId" params={{ broadcastId: b.followUp.id }}>
          {b.followUp.at ? `Clears ${formatDateTime(b.followUp.at)}` : 'Clears later'}
        </MetaLink>
      ) : null}
    </>
  );
}
