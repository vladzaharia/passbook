import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebhookEndpointDto } from '../../../shared/contracts/webhooks.ts';
import type { FeedQuery, TesterApi } from './client.ts';
import { byNewest, captureRow, deliveryRow, type Row, testRow } from './model.ts';

const POLL_MS = 3000;
const FRESH_MS = 4000;

/** The rows of one endpoint under a query: captures for a capture endpoint, deliveries and test sends for a URL one. */
export async function loadRows(
  api: TesterApi,
  endpoint: WebhookEndpointDto,
  q: FeedQuery,
): Promise<Row[]> {
  if (endpoint.target === 'capture') return (await api.captures(endpoint.id, q)).map(captureRow);
  const [d, t] = await Promise.all([api.deliveries(endpoint.id, q), api.tests(endpoint.id)]);
  const tests = q.requestId || q.passId ? [] : t.map((x) => testRow(x, endpoint.id));
  return byNewest([...d.map((x) => deliveryRow(x, endpoint.id)), ...tests]);
}

export interface Feed {
  rows: Row[];
  /** The first read of this endpoint and query has answered. */
  ready: boolean;
  /** The first read failed; Retry reads again. */
  failed: boolean;
  /** The tab is hidden: polling waits. */
  paused: boolean;
  /** Rows that arrived since the last poll: they rise in, then glow. */
  fresh: ReadonlySet<string>;
  reload: () => Promise<void>;
  resume: () => void;
}

/**
 * One list that stays current: read now, every 3 s while the tab is shown, and on demand. A new
 * endpoint or query starts over (no rows of the last one stay on screen).
 */
export function useFeed(api: TesterApi, endpoint: WebhookEndpointDto | null, q: FeedQuery): Feed {
  const key = `${endpoint?.id ?? ''}|${q.type ?? ''}|${q.requestId ?? ''}|${q.passId ?? ''}`;
  const [read, setRead] = useState<{ key: string; rows: Row[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [paused, setPaused] = useState(() => typeof document !== 'undefined' && document.hidden);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const known = useRef<{ key: string; ids: Set<string> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the query's contents.
  const load = useCallback(async () => {
    if (!endpoint) return;
    try {
      const rows = await loadRows(api, endpoint, q);
      const seen = known.current?.key === key ? known.current.ids : null;
      const arrived = seen ? rows.filter((r) => !seen.has(r.id)).map((r) => r.id) : [];
      known.current = { key, ids: new Set(rows.map((r) => r.id)) };
      setRead({ key, rows });
      setFailed(false);
      if (arrived.length > 0) {
        setFresh(new Set(arrived));
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setFresh(new Set()), FRESH_MS);
      }
    } catch {
      // Kept: a later poll reads again. Only a first read that fails shows Retry.
      setFailed(true);
    }
  }, [api, endpoint, key]);

  useEffect(() => {
    if (!endpoint) return;
    void load();
    const tick = () => {
      if (document.hidden) setPaused(true);
      else {
        setPaused(false);
        void load();
      }
    };
    const poll = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(poll);
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [endpoint, load]);

  const ready = read?.key === key;
  return {
    rows: ready ? read.rows : [],
    ready,
    failed: failed && !ready,
    paused,
    fresh,
    reload: load,
    resume: () => {
      setPaused(false);
      void load();
    },
  };
}
