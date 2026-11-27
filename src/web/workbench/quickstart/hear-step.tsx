import { Check, Send, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import { SDK_STATUS } from '../../../shared/developers-sdk.ts';
import { ApiError } from '../../lib/errors.ts';
import { formatTime } from '../../lib/format.ts';
import { isLimited } from '../../lib/poll-backoff.ts';
import { type LiveClient, PORTAL_READ } from '../playground/live.ts';
import { Step, type StepState } from './parts.tsx';
import { useSinglePoll } from './single-poll.ts';
import type { Quickstart } from './use-quickstart.ts';

const H = QS_COPY.hear;

/** The capture endpoint's newest events, read with the sandbox's own Try it token. */
function useCaptures(client: LiveClient | null, endpointId: string | undefined, active: boolean) {
  const [items, setItems] = useState<WebhookCaptureDto[]>([]);
  const read = useCallback(async () => {
    if (!client || !endpointId) return;
    try {
      const page = await client.send<{ items: WebhookCaptureDto[] }>(
        'GET',
        `/webhook-endpoints/${encodeURIComponent(endpointId)}/captures?limit=10`,
        undefined,
        PORTAL_READ,
      );
      // Events can arrive in any order: the list is by event time, newest first.
      if (page.body) setItems([...page.body.items].sort((a, b) => b.createdAt - a.createdAt));
      else if (page.status === 429)
        throw new ApiError({ status: 429, code: 'rate_limited', retryAfter: page.retryAfter });
    } catch (error) {
      // The list keeps what it has; the next poll asks again. A 429 slows the page's loop.
      if (isLimited(error)) throw error;
    }
  }, [client, endpointId]);
  useEffect(() => {
    void read();
  }, [read]);
  useSinglePoll('hear', active, read);
  return { items, read };
}

/** Signed: PassBook's own signature header is on the capture, as it would be on a delivery. */
const verified = (c: WebhookCaptureDto): boolean =>
  Object.keys(c.headers).some((h) => /signature/i.test(h));

/** Hear back: the events the sandbox captured, signed and never sent, and a way to send one more. */
export function HearStep({
  q,
  state,
  onFinish,
}: {
  q: Quickstart;
  state: StepState;
  onFinish: () => void;
}) {
  const endpoint = q.home?.endpoints.find((e) => e.target === 'capture');
  const open = q.pass !== null;
  const { items, read } = useCaptures(q.client, endpoint?.id, open && state !== 'done');
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!q.client || !endpoint) return;
    setSending(true);
    try {
      await q.client.send('POST', `/webhook-endpoints/${encodeURIComponent(endpoint.id)}/test`, {
        type: 'webhook.test',
      });
      await read();
      void q.refresh();
    } finally {
      setSending(false);
    }
  };
  return (
    <Step n={5} state={state} title={H.title}>
      {open ? (
        <>
          <p className="sm muted">{H.line}</p>
          <div className="qs-hear card">
            <div className="row g2 qs-hear-h">
              <h3 className="h3">{H.endpoint}</h3>
              <button
                type="button"
                className="btn outline sm push"
                disabled={sending || !endpoint}
                aria-busy={sending}
                onClick={() => void send()}
              >
                <Send aria-hidden="true" />
                {sending ? H.sending : H.send}
              </button>
            </div>
            {items.length === 0 ? (
              <p className="xs muted qs-note">{H.empty}</p>
            ) : (
              <ol className="qs-caps">
                {items.map((c) => (
                  <li key={c.id} className="qs-cap">
                    <span className="mono xs qs-cap-s">{c.status}</span>
                    <span className="mono sm">{c.type}</span>
                    {verified(c) ? (
                      <span className="pill success">
                        <ShieldCheck aria-hidden="true" />
                        {H.verified}
                      </span>
                    ) : null}
                    <time
                      className="mono xs muted push"
                      dateTime={new Date(c.createdAt).toISOString()}
                    >
                      {formatTime(c.createdAt)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="qs-hear-2">
            <section className="card qs-hear-c">
              <h3 className="h3">{H.own}</h3>
              <p className="xs muted">{H.ownLine}</p>
              <a className="btn outline sm" href={PATHS.webhooks}>
                {H.ownCta}
              </a>
            </section>
            <section className="card qs-hear-c">
              <div className="row g2">
                <h3 className="h3">{H.local}</h3>
                {SDK_STATUS.cli ? null : <span className="qs-soon-pill push">{H.soon}</span>}
              </div>
              <pre className="mono xs">
                npx @passbook/cli listen --forward-to localhost:3000/hooks
              </pre>
              <p className="xs muted">{H.localLine}</p>
            </section>
          </div>
          {state !== 'done' ? (
            <p>
              <button
                type="button"
                className="btn"
                onClick={onFinish}
                disabled={items.length === 0}
              >
                {H.finish}
                <Check aria-hidden="true" />
              </button>
            </p>
          ) : null}
        </>
      ) : null}
    </Step>
  );
}
