import { type CSSProperties, Fragment } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { IdChip, type IdKind } from './id-chip.tsx';
import './kit.css';

/** One step of the story: an id that opens in its tool, and the words that name it. */
export interface TraceNode {
  kind: IdKind;
  /** Left out when there is none: the Trace never says "unknown". */
  id: string | null | undefined;
  text: string;
  /** The quiet word before it ("key"). */
  prefix?: string;
}

/** What the Trace can tell about a moment: the key that called, the request, the events it caused. */
export interface TraceFacts {
  key?: { id: string; name: string; prefix: string } | null;
  request?: { id: string | null; method: string; path: string; status: number } | null;
  events?: readonly { id: string; type: string }[];
}

/** key → request → events, in that order, with whatever is known. */
export function traceNodes({ key, request, events = [] }: TraceFacts): TraceNode[] {
  return [
    ...(key
      ? [{ kind: 'key' as const, id: key.id, text: `${key.name} ${key.prefix}…`, prefix: 'key' }]
      : []),
    ...(request
      ? [
          {
            kind: 'request' as const,
            id: request.id,
            text: `${request.method} ${request.path} ${request.status}`,
          },
        ]
      : []),
    ...events.map((e) => ({ kind: 'event' as const, id: e.id, text: e.type })),
  ];
}

/**
 * The strip that ends every inspector and ties the four tools into one story:
 * `key Default …a1f3 → POST /passes 201 → pass.issued`. Each node is an IdChip that opens its tool
 * with the item selected. Nodes without an id are left out; with none, there is no strip.
 */
export function Trace({ nodes }: { nodes: readonly TraceNode[] }) {
  const shown = nodes.filter((n): n is TraceNode & { id: string } => !!n.id);
  if (shown.length === 0) return null;
  return (
    <nav className="bench-trace" aria-label={BENCH_COPY.trace}>
      <span className="bench-trace-l" aria-hidden="true">
        {BENCH_COPY.trace}
      </span>
      <ol className="bench-trace-n">
        {shown.map((n, i) => (
          <Fragment key={`${n.kind}:${n.id}`}>
            {i > 0 ? (
              <li
                className="bench-trace-a"
                aria-hidden="true"
                style={{ '--i': i * 2 - 1 } as CSSProperties}
              >
                →
              </li>
            ) : null}
            <li style={{ '--i': i * 2 } as CSSProperties}>
              <IdChip id={n.id} kind={n.kind} text={n.text} prefix={n.prefix} />
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
