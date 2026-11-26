import type { ReactNode } from 'react';
import { actionOf } from '@/web/lib/actions.ts';
import { formatDateTime, formatDay, pluralize } from '@/web/lib/format.ts';
import { CopyButton } from '@/web/ui/copy-button.tsx';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  KeyValue,
  type KeyValueItem,
  RelTime,
  SkeletonRows,
  StatusPill,
} from '@/web/ui/index.ts';
import { ROLE_LABELS } from '../orgs/org-roles.ts';
import type { ApiKeyActivity, ApiKeyDetail } from './detail-queries.ts';
import { keyPrefix, STATE_TONE } from './key-columns.tsx';
import { keyReach } from './key-kind-fields.ts';
import { KeyNameLink } from './key-name-link.tsx';
import { type ApiKey, keyState, SCOPE_LABEL } from './queries.ts';

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="px-4 py-5 text-sm text-fg-muted">{children}</p>
);

export function AccessCard({
  detail: k,
  now,
  orgName,
}: {
  detail: ApiKeyDetail;
  now: number;
  orgName: string;
}) {
  const items: KeyValueItem[] = [
    {
      label: 'Key',
      value: (
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 break-all">{keyPrefix(k)}</span>
          <CopyButton value={keyPrefix(k)} label="Copy key" />
        </span>
      ),
      mono: true,
    },
    k.orgId === null
      ? { label: 'Reaches', value: keyReach(k) }
      : { label: 'Organization', value: orgName },
    { label: 'Mode', value: k.mode === 'test' ? 'Test' : 'Live' },
    {
      label: 'Permissions',
      value: (
        <ul className="flex flex-wrap gap-1.5">
          {[...k.roles.map((r) => ROLE_LABELS[r]), ...k.scopes.map((s) => SCOPE_LABEL[s] ?? s)].map(
            (label) => (
              <li key={label}>
                <Badge>{label}</Badge>
              </li>
            ),
          )}
        </ul>
      ),
    },
    ...(k.templateIds.length || k.passStyles.length
      ? [
          {
            label: 'Limited to',
            value: [
              k.templateIds.length ? pluralize(k.templateIds.length, 'template') : '',
              k.passStyles.length ? k.passStyles.join(', ') : '',
            ]
              .filter(Boolean)
              .join(' · '),
          },
        ]
      : []),
    { label: 'Allowed IPs', value: k.ipAllow.length ? k.ipAllow.join(', ') : 'Any address' },
    { label: 'Expires', value: formatDay(k.expiresAt, 'No expiry') },
    ...(k.retireAt === null
      ? []
      : [
          {
            label: k.retireAt <= now ? 'Retired' : 'Retires',
            value: formatDateTime(k.retireAt),
          },
        ]),
    {
      label: 'Created',
      value: `${formatDay(k.createdAt)}${k.createdByName ? ` by ${k.createdByName}` : ''}`,
    },
    {
      label: 'Last used',
      value: k.lastUsedAt ? (
        <>
          <RelTime at={k.lastUsedAt} now={now} />
          {k.lastIpPrefix ? <span className="text-fg-muted"> from {k.lastIpPrefix}</span> : null}
        </>
      ) : (
        'Never'
      ),
    },
    ...(k.parent
      ? [
          {
            label: 'Minted by',
            value: (
              <KeyNameLink orgId={k.orgId} id={k.parent.id}>
                {k.parent.name}
              </KeyNameLink>
            ),
          },
        ]
      : []),
    ...(k.replacedBy
      ? [
          {
            label: 'Replaced by',
            value: (
              <KeyNameLink orgId={k.orgId} id={k.replacedBy.id}>
                {k.replacedBy.name}
              </KeyNameLink>
            ),
          },
        ]
      : []),
    ...(k.rotatedFrom
      ? [
          {
            label: 'Replaces',
            value: (
              <KeyNameLink orgId={k.orgId} id={k.rotatedFrom}>
                Previous key
              </KeyNameLink>
            ),
          },
        ]
      : []),
  ];
  return (
    <Card>
      <CardHeader title="Access" />
      <CardBody>
        <KeyValue items={items} />
      </CardBody>
    </Card>
  );
}

export function ChildrenCard({
  keys: rows,
  now,
  orgId,
  loading,
  error,
  onRetry,
}: {
  keys: ApiKey[] | undefined;
  now: number;
  orgId: string | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (!loading && !error && !rows?.length) return null;
  return (
    <Card>
      <CardHeader title="Child keys" />
      {loading ? (
        <SkeletonRows label="Loading child keys" />
      ) : error ? (
        <ErrorState inline subject="child keys" error={error} onRetry={onRetry} />
      ) : (
        <ul className="divide-y divide-border">
          {(rows ?? []).map((child) => {
            const state = keyState(child, now);
            return (
              <li
                key={child.id}
                className="flex min-h-14 items-center justify-between gap-3 px-4 py-2"
              >
                <div className="min-w-0">
                  <KeyNameLink orgId={orgId} id={child.id}>
                    {child.name}
                  </KeyNameLink>
                  <p className="truncate text-xs text-fg-muted">
                    {child.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(', ')}
                  </p>
                </div>
                <StatusPill status={state} tone={STATE_TONE[state]} />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function ActivityCard({
  data,
  now,
  loading,
  error,
  onRetry,
}: {
  data: ApiKeyActivity | undefined;
  now: number;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader title="Activity" />
      {loading ? (
        <SkeletonRows label="Loading activity" />
      ) : error || !data ? (
        <ErrorState inline subject="activity" error={error} onRetry={onRetry} />
      ) : data.recent.length === 0 ? (
        <Empty>No calls recorded.</Empty>
      ) : (
        <>
          <CardBody className="border-b border-border">
            <p className="text-sm text-fg-strong">
              {data.summary.calls} {data.summary.calls === 1 ? 'call' : 'calls'} in 30 days
              {data.summary.denied > 0 ? (
                <span className="text-warning"> · {data.summary.denied} refused</span>
              ) : null}
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {data.summary.actions.slice(0, 6).map((a) => (
                <li key={a.action}>
                  <Badge>
                    {actionOf(a.action).label} · {a.count}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardBody>
          <ul className="divide-y divide-border">
            {data.recent.map((call) => (
              <li
                key={call.id}
                className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 text-sm"
              >
                <span className="min-w-0 truncate text-fg">
                  {actionOf(call.action).label}
                  {call.code ? <span className="text-fg-muted"> · {call.code}</span> : null}
                </span>
                <span className="shrink-0 text-xs text-fg-muted">
                  <RelTime at={call.at} now={now} />
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
