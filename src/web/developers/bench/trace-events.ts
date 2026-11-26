/** The tool's own signed-in call (webhooks' try-token client): GET a path under /api/v1. */
export type BenchGet = <T>(path: string) => Promise<T>;

/** An event a request caused, as the Trace and the Logs inspector show it. */
export interface CausedEvent {
  /** The event id: `webhooks#<id>` selects its delivery. */
  id: string;
  type: string;
  /** The answer it got: a capture's status, or a delivery's last one; null while pending. */
  status: number | null;
  endpointId: string;
}

interface Endpoint {
  id: string;
  target: 'url' | 'capture';
}
interface Capture {
  eventId: string;
  type: string;
  status: number;
}
interface Delivery {
  eventId: string;
  type: string;
  lastStatus: number | null;
}

/**
 * The webhook events one API request caused (WB0's `requestId` filter), across every endpoint of the
 * sandbox: captures for a capture endpoint, deliveries for a URL one. One event sent to two
 * endpoints is listed once, with the first answer found.
 */
export async function loadRequestEvents(requestId: string, get: BenchGet): Promise<CausedEvent[]> {
  const rid = encodeURIComponent(requestId);
  const { items: endpoints } = await get<{ items: Endpoint[] }>('/webhook-endpoints?limit=100');
  const lists = await Promise.all(
    endpoints.map(async (e): Promise<CausedEvent[]> => {
      if (e.target === 'capture') {
        const { items } = await get<{ items: Capture[] }>(
          `/webhook-endpoints/${e.id}/captures?requestId=${rid}`,
        );
        return items.map((c) => ({
          id: c.eventId,
          type: c.type,
          status: c.status,
          endpointId: e.id,
        }));
      }
      const { items } = await get<{ items: Delivery[] }>(
        `/webhook-endpoints/${e.id}/deliveries?requestId=${rid}`,
      );
      return items.map((d) => ({
        id: d.eventId,
        type: d.type,
        status: d.lastStatus,
        endpointId: e.id,
      }));
    }),
  );
  const seen = new Set<string>();
  return lists.flat().filter((e) => !seen.has(e.id) && !!seen.add(e.id));
}
