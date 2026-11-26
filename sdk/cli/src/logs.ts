export interface LogLine {
  id: string;
  at: number;
  method: string;
  path: string;
  status: number;
  code: string | null;
  durationMs: number;
  requestId: string;
}

export interface LogsApi {
  requestLogs: {
    list(query?: {
      after?: string;
      status?: string;
      code?: string;
      limit?: number;
    }): PromiseLike<{ items: LogLine[] }>;
  };
}

export interface LogsOptions {
  api: LogsApi;
  /** Only this status class (`4xx`) or status. */
  status?: string;
  code?: string;
  intervalMs?: number;
  /** Poll once, print, and return. */
  once?: boolean;
  log: (line: string) => void;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const PAGE = 100;

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

export const logLine = (l: LogLine): string =>
  [
    new Date(l.at).toISOString().slice(11, 19),
    l.method.padEnd(6),
    l.status,
    l.path.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?'),
    `${l.durationMs} ms`,
    (l.code ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?'),
    l.requestId.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?'),
  ]
    .join('  ')
    .replace(/ {2}(?= {2}|$)/g, '')
    .trimEnd();

/**
 * Prints the Test calls that arrive after starting, oldest first, until aborted (or once). The cursor is the id of
 * the newest call seen (log ids sort by time), so a filter that matches nothing never re-reads. Returns how many lines were printed.
 */
export async function followLogs(o: LogsOptions): Promise<number> {
  const sleep = o.sleep ?? wait;
  let after = (await o.api.requestLogs.list({ limit: 1 })).items[0]?.id;
  let printed = 0;
  const seen = new Set<string>();
  const filtered = Boolean(o.status || o.code);
  do {
    if (o.signal?.aborted) break;
    // A filtered page hides newer calls that do not match, so the cursor is the unfiltered newest, read first.
    const newest = filtered ? (await o.api.requestLogs.list({ limit: 1 })).items[0]?.id : undefined;
    const { items } = await o.api.requestLogs.list({
      limit: PAGE,
      ...(after ? { after } : {}),
      ...(o.status ? { status: o.status } : {}),
      ...(o.code ? { code: o.code } : {}),
    });
    for (const l of [...items].reverse()) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      if (seen.size > 2000) seen.delete(seen.values().next().value as string);
      o.log(logLine(l));
      printed++;
    }
    after = (filtered ? newest : items[0]?.id) ?? after;
    if (o.once) break;
    await sleep(o.intervalMs ?? 2000, o.signal);
  } while (!o.signal?.aborted);
  return printed;
}
