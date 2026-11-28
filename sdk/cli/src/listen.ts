import type { Api, Capture } from './api.ts';
import { forward, receiverUrl } from './forward.ts';

export interface ListenOptions {
  api: Api;
  forwardTo: string;
  /** A capture endpoint's id; default: the sandbox's own, made if it has none. */
  endpointId?: string;
  intervalMs?: number;
  /** Also forward the captures already stored. Default: only those that arrive after starting. */
  fromStart?: boolean;
  /** Poll once, forward, and return. */
  once?: boolean;
  fetch?: typeof fetch;
  log: (line: string) => void;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  clock?: () => number;
}

const PAGE = 100;
/** A burst larger than this is not caught up in one poll; the rest is forwarded on the next. */
const MAX_PAGES = 5;
const REMEMBER = 2000;

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** The endpoint to poll, and its signing secret when it can be read. */
async function endpoint(o: ListenOptions): Promise<string> {
  let id = o.endpointId;
  let secret: string | null = null;
  if (!id) {
    const made = await o.api.webhookEndpoints.ensureCapture({});
    id = made.endpoint.id;
    secret = made.secret;
  }
  if (secret === null) o.log('Read the signing secret in the Workbench.');
  if (secret !== null) o.log(`Signing secret: ${secret}`);
  return id;
}

/** Forwards each new capture to `forwardTo`, oldest first, until aborted (or once). Returns how many were sent. */
export async function listen(o: ListenOptions): Promise<number> {
  const url = receiverUrl(o.forwardTo);
  const clock = o.clock ?? Date.now;
  const sleep = o.sleep ?? wait;
  const id = await endpoint(o);
  o.log(`Forwarding captures of ${id} to ${url}`);

  const seen = new Set<string>();
  const remember = (c: Capture) => {
    seen.add(c.id);
    if (seen.size > REMEMBER) seen.delete(seen.values().next().value as string);
  };
  let sent = 0;
  let first = true;
  do {
    // Newest first: walk back until a capture already seen, or the end.
    const fresh: Capture[] = [];
    let cursor: string | undefined;
    let caughtUp = false;
    for (let page = 0; page < MAX_PAGES && !caughtUp; page++) {
      const res = await o.api.webhookEndpoints.captures.list(id, {
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      });
      for (const c of res.items) {
        if (seen.has(c.id)) caughtUp = true;
        else fresh.push(c);
      }
      cursor = res.nextCursor ?? undefined;
      if (!cursor || (first && !o.fromStart)) break;
    }
    const toSend = first && !o.fromStart ? [] : fresh.reverse();
    for (const c of fresh) remember(c);
    first = false;
    for (const c of toSend) {
      const r = await forward(c, url, o.fetch, clock);
      sent++;
      const time = new Date(clock()).toISOString().slice(11, 19);
      o.log(
        `${time}  ${c.type}  ${c.eventId}  ${r.status === null ? `failed: ${r.error}` : `${r.status} (${r.ms} ms)`}`,
      );
    }
    if (o.once || o.signal?.aborted) break;
    await sleep(o.intervalMs ?? 2000, o.signal);
  } while (!o.signal?.aborted);
  return sent;
}
