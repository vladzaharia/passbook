import { useEffect, useState } from 'react';
import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import { type LiveClient, PORTAL_READ } from '../playground/live.ts';
import type { Caught, QsPass } from './types.ts';

const POLL_MS = 1500;
const POLLS = 14;

/**
 * Waits for the sandbox's capture endpoint to catch the events the pass caused. It looks for a short while, then
 * stops: an event that has not come is "not captured yet", never an error.
 */
export function useCaught(
  client: LiveClient | null,
  pass: QsPass | null,
): { caught: Caught; over: boolean } {
  const [caught, setCaught] = useState<Caught>({});
  const [over, setOver] = useState(false);
  const id = pass?.id;
  const version = pass?.version;
  useEffect(() => {
    if (!client || !id || version === undefined) return;
    let live = true;
    setOver(false);
    const want = version === 1 ? 'pass.issued' : 'pass.updated';
    (async () => {
      const made = await client.send<{ endpoint: { id: string } }>(
        'POST',
        '/webhook-endpoints/capture',
        {},
      );
      const endpoint = made.body?.endpoint.id;
      if (!endpoint) return;
      for (let i = 0; i < POLLS && live; i++) {
        const page = await client.send<{ items: WebhookCaptureDto[] }>(
          'GET',
          `/webhook-endpoints/${encodeURIComponent(endpoint)}/captures?limit=20&type=${want}`,
          undefined,
          PORTAL_READ,
        );
        const hit = page.body?.items.find((c) => c.body.includes(id));
        if (hit) {
          if (live) setCaught((c) => ({ ...c, [want]: hit.createdAt }));
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (live) setOver(true);
    })().catch(() => {
      // The timeline says "not captured yet"; the pass itself is already made.
    });
    return () => {
      live = false;
    };
  }, [client, id, version]);
  return { caught, over };
}
