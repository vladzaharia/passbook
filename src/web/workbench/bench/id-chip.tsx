import { Ellipsis } from 'lucide-react';
import { useRef, useState } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { PATHS } from '../../../shared/developers.ts';
import { copyWithFeedback } from '../../developers/shell/copy.ts';
import { BenchMenu, type BenchMenuItem } from './menu.tsx';
import './kit.css';

/** What an id names, which decides where it can open. `id` is anything else: it resolves on demand. */
export type IdKind = 'request' | 'event' | 'key' | 'pass' | 'op' | 'id';

const J = BENCH_COPY.id.jump;
const KIND_WORD: Record<IdKind, string> = {
  request: 'request',
  event: 'event',
  key: 'key',
  pass: 'pass',
  op: 'operation',
  id: 'object',
};
/** What `/developer/resolve` takes: a UUID or a Cloudflare ray. */
const RESOLVABLE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16}-[a-z]{3})$/i;

/** `01a2b3c4…c3ed`: the head and the tail, enough to tell two apart. */
export const shortId = (id: string): string =>
  id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;

const q = (id: string) => encodeURIComponent(id);

/** Where an id opens, by kind: the item selected in its tool, or a tool filtered to it (bench URL grammar). */
export function jumpTargets(kind: IdKind, id: string): BenchMenuItem[] {
  const to = (key: string, label: string, href: string) => ({ key, label, href });
  switch (kind) {
    case 'request':
      return [
        to('logs', J.logs, `${PATHS.logs}?source=all#${q(id)}`),
        to('events', J.events, `${PATHS.webhooks}?request=${q(id)}`),
      ];
    case 'event':
      return [to('webhooks', J.webhooks, `${PATHS.webhooks}#${q(id)}`)];
    case 'key':
      return [
        to('keys', J.keys, `${PATHS.keys}#${q(id)}`),
        to('calls', J.calls, `${PATHS.logs}?key=${q(id)}`),
      ];
    case 'pass':
      return [
        to('calls', J.passCalls, `${PATHS.logs}?path=${q(id)}&source=all`),
        to('events', J.passEvents, `${PATHS.webhooks}?pass=${q(id)}`),
      ];
    case 'op':
      return [to('console', J.console, `${PATHS.console}#${q(id)}`)];
    default:
      return [];
  }
}

/** An unknown id, looked up once: the place it opens, or nothing in this sandbox. */
async function resolve(id: string): Promise<BenchMenuItem[]> {
  try {
    const res = await fetch(`/api/v1/developer/resolve?id=${q(id)}`, {
      headers: { accept: 'application/json' },
    });
    if (res.ok) {
      const found = (await res.json()) as { href?: unknown; label?: unknown };
      if (typeof found.href === 'string' && found.href.startsWith(PATHS.home))
        return [{ key: 'found', label: String(found.label ?? found.href), href: found.href }];
    }
  } catch (error) {
    // Offline: the menu says it found nothing, and the page's handler hears why.
    reportError(error);
  }
  return [{ key: 'none', label: BENCH_COPY.id.unknown, disabled: true }];
}

/**
 * An id as a chip: `01a2…c3ed` in mono. A press copies it (Copied, 1.5 s); `⋯` opens it in the
 * tool that holds it, by kind (bench URL grammar), and an unknown id resolves first. `text` shows a
 * name in place of the id ("Default …a1f3"); `prefix` is the quiet word before it ("req", "key").
 */
export function IdChip({
  id,
  kind = 'id',
  text,
  prefix,
}: {
  id: string;
  kind?: IdKind;
  text?: string;
  prefix?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [found, setFound] = useState<BenchMenuItem[] | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const known = jumpTargets(kind, id);
  const items = kind === 'id' ? found : known;
  const canJump = kind !== 'id' || RESOLVABLE.test(id);
  const word = KIND_WORD[kind];
  return (
    <span className="bench-id" data-kind={kind}>
      <button
        ref={button}
        type="button"
        className="bench-id-c"
        title={id}
        // The name starts with what is drawn (WCAG 2.5.3), then says what the button does.
        aria-label={`${prefix ? `${prefix} ` : ''}${text ?? shortId(id)}, ${BENCH_COPY.id.copy(word, id)}`}
        onClick={() =>
          void copyWithFeedback(id, button.current).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {prefix ? <span className="bench-id-p">{prefix}</span> : null}
        {prefix ? ' ' : null}
        <span className="bench-id-v">{copied ? BENCH_COPY.id.copied : (text ?? shortId(id))}</span>
      </button>
      {canJump ? (
        <BenchMenu
          className="bench-id-m"
          label={BENCH_COPY.id.open(word)}
          trigger={<Ellipsis aria-hidden="true" />}
          items={items ?? [{ key: 'wait', label: BENCH_COPY.loading, disabled: true }]}
          onOpen={() => {
            if (kind === 'id' && !found) void resolve(id).then(setFound);
          }}
        />
      ) : null}
    </span>
  );
}
