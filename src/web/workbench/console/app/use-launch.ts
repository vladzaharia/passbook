import { useEffect, useMemo, useRef, useState } from 'react';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import type { ConsoleClient } from '../client.ts';
import { bodyOfLog, fillFor, type Launch, matchOp } from '../launch.ts';
import type { Prefill } from '../prefill.ts';
import type { RunOp } from '../types.ts';
import type { IndexOp } from './index-pane.tsx';

const C = CONSOLE_COPY;

/** What `GET /request-logs/{id}` says about a call: the parts the Console fills a request from. */
interface LogDetail {
  method?: unknown;
  path?: unknown;
  query?: unknown;
  requestBody?: unknown;
}

export type LogRead =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'gone' }
  | { state: 'ready'; detail: LogDetail; opId: string | null; ids: Record<string, string> };

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Reads the Logs row named by `?from=` once; the operation it was is matched by method and path when `?op=` is absent. */
export function useLogRead(
  client: ConsoleClient | null,
  from: string | null,
  ops: readonly IndexOp[],
): LogRead {
  const [read, setRead] = useState<LogRead>({ state: 'none' });
  const ready = ops.length > 0;
  const opsRef = useRef(ops);
  opsRef.current = ops;
  useEffect(() => {
    if (!from || !client || !ready) return setRead({ state: 'none' });
    let live = true;
    setRead({ state: 'loading' });
    const org = client.orgId ? `?orgId=${encodeURIComponent(client.orgId)}` : '';
    client.get<LogDetail>(`/request-logs/${encodeURIComponent(from)}${org}`).then(
      (detail) => {
        if (!live) return;
        const hit = matchOp(opsRef.current, str(detail.method) ?? '', str(detail.path) ?? '');
        setRead({ state: 'ready', detail, opId: hit?.id ?? null, ids: hit?.ids ?? {} });
      },
      () => live && setRead({ state: 'gone' }),
    );
    return () => {
      live = false;
    };
  }, [client, from, ready]);
  return read;
}

/** The request to start from, and the line over the form saying where it came from. */
export function useFill(
  op: RunOp | null,
  launch: Launch,
  log: LogRead,
): { prefill: Prefill | null; note: string | null } {
  return useMemo(() => {
    if (!op) return { prefill: null, note: null };
    if (launch.from) {
      if (log.state !== 'ready')
        return { prefill: null, note: log.state === 'gone' ? C.logGone : null };
      const body = bodyOfLog(
        typeof log.detail.requestBody === 'string' ? log.detail.requestBody : null,
      );
      const query = Object.fromEntries(
        new URLSearchParams(typeof log.detail.query === 'string' ? log.detail.query : ''),
      );
      return {
        prefill: { query, path: log.ids, literal: true, ...(body !== undefined ? { body } : {}) },
        note: body === undefined && op.body ? C.bodiesOff : C.fromLog(launch.from),
      };
    }
    const fill = fillFor(op, launch);
    return {
      prefill: fill.source === 'reference' ? null : fill.prefill,
      note: fill.note,
    };
  }, [op, launch, log]);
}
