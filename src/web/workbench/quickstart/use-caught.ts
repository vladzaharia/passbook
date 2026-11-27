import { useEffect, useRef, useState } from 'react';
import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import { ApiError } from '../../lib/errors.ts';
import { isLimited } from '../../lib/poll-backoff.ts';
import { type LiveClient, PORTAL_READ } from '../playground/live.ts';
import { useSinglePoll } from './single-poll.ts';
import type { Caught, QsPass } from './types.ts';

/** After this long the timeline says "not captured yet". */
const WAIT_MS = 30_000;

/**
 * Waits for the sandbox's capture endpoint to catch the events the pass caused, on the page's shared poll loop. It
 * looks for a short while, then stops: an event that has not come is "not captured yet", never an error.
 */
export function useCaught(
  client: LiveClient | null,
  pass: QsPass | null,
): { caught: Caught; over: boolean } {
  const [caught, setCaught] = useState<Caught>({});
  const [over, setOver] = useState(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const until = useRef(0);
  const id = pass?.id;
  const version = pass?.version;
  const want = version === 1 ? 'pass.issued' : 'pass.updated';
  useEffect(() => {
    if (!client || !id || version === undefined) return;
    let live = true;
    setOver(false);
    setEndpoint(null);
    until.current = Date.now() + WAIT_MS;
    client
      .send<{ endpoint: { id: string } }>('POST', '/webhook-endpoints/capture', {})
      .then((made) => {
        if (live && made.body) setEndpoint(made.body.endpoint.id);
      })
      .catch(() => {
        // The timeline says "not captured yet"; the pass itself is already made.
      });
    return () => {
      live = false;
    };
  }, [client, id, version]);
  useSinglePoll('caught', endpoint !== null && !over, async () => {
    if (!client || !id || !endpoint) return;
    if (Date.now() > until.current) return setOver(true);
    try {
      const page = await client.send<{ items: WebhookCaptureDto[] }>(
        'GET',
        `/webhook-endpoints/${encodeURIComponent(endpoint)}/captures?limit=20&type=${want}`,
        undefined,
        PORTAL_READ,
      );
      const hit = page.body?.items.find((c) => c.body.includes(id));
      if (hit) {
        setCaught((c) => ({ ...c, [want]: hit.createdAt }));
        setEndpoint(null);
      } else if (page.status === 429) {
        throw new ApiError({ status: 429, code: 'rate_limited', retryAfter: page.retryAfter });
      }
    } catch (error) {
      if (isLimited(error)) throw error;
    }
  });
  return { caught, over };
}
