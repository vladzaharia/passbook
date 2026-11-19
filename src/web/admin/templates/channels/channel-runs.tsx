import type { ChannelApplyRunDto } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY } from '@/shared/copy/channels.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { Card, CardBody, CardHeader, StatusPill } from '../../../ui/index.ts';
import { useChannelRuns } from './api.ts';

const SHOWN = 5;

/** The state pill's key: a superseded run is neutral, not an error. */
const pillOf = (r: ChannelApplyRunDto) =>
  r.state === 'dropped' ? 'cancelled' : r.state === 'done' ? 'complete' : r.state;

/** Why a run did less than asked, one sentence; failed runs get a generic retry hint. */
function problem(r: ChannelApplyRunDto): string | null {
  if (r.errorCode === 'REPLACE_PRINCIPAL_REVOKED') return CHANNEL_COPY.runPrincipalRevoked;
  if (r.errorCode === 'CHANNEL_REPLACE_WINDOW_TIMEOUT') return CHANNEL_COPY.runWindowTimeout;
  return r.state === 'failed' ? CHANNEL_COPY.runFailed : null;
}

function summary(r: ChannelApplyRunDto): string {
  const changed = r.counts.changed ?? 0;
  const rotated = r.counts.rotated ?? 0;
  return [
    changed === 1
      ? CHANNEL_COPY.runPassesOne
      : CHANNEL_COPY.runPasses.replace('{n}', String(changed)),
    rotated > 0 ? CHANNEL_COPY.runRotated.replace('{n}', String(rotated)) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** How recent saves are being applied to passes: pending, running, done, failed. Hidden when none. */
export function ChannelRuns({ templateId, orgId }: { templateId: string; orgId: string }) {
  const runs = useChannelRuns(templateId, orgId).data?.slice(0, SHOWN);
  if (!runs?.length) return null;
  return (
    <Card>
      <CardHeader title={CHANNEL_COPY.runsTitle} />
      <CardBody>
        <ul className="divide-y divide-border">
          {runs.map((r) => {
            const issue = problem(r);
            return (
              <li key={r.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-4">
                <div className="flex shrink-0 items-center gap-2 sm:w-52">
                  <StatusPill status={pillOf(r)}>
                    {r.state === 'dropped'
                      ? CHANNEL_COPY.runDropped
                      : r.state === 'done'
                        ? 'Done'
                        : undefined}
                  </StatusPill>
                </div>
                <div className="min-w-0 text-sm">
                  {r.state === 'dropped' ? null : <p className="text-fg-strong">{summary(r)}</p>}
                  {issue ? (
                    <p
                      className={
                        r.state === 'failed' ? 'text-xs text-danger' : 'text-xs text-warning'
                      }
                    >
                      {issue}
                    </p>
                  ) : null}
                  <p className="text-xs text-fg-muted">
                    {formatDateTime(r.finishedAt ?? r.startedAt ?? r.dueAt)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
