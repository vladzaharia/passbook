import type { RequestLogDetail, RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { PATHS } from '../../../shared/developers.ts';
import { copyAs } from '../console/copy-as.ts';
import type { Json } from '../console/types.ts';
import { highlightTokens, type Tok } from '../model/highlight.ts';
import { statusText } from '../ui/status-text.ts';
import { fill, getJson, h } from './dom.ts';
import { clock, prettyBody } from './format.ts';
import { icon } from './icons.ts';
import { builderLink, type OpIndex } from './ops.ts';
import { duration, fullTime } from './row-format.ts';

const D = LOGS_COPY.detail;
export const LOG_API = '/api/v1/developer/logs';

/** The logged call as curl, with the key read from `$PASSBOOK_KEY`; a body that is not JSON is left out. */
export function curlOf(row: RequestLogDetail, origin: string): string {
  let body: Json | undefined;
  try {
    body = row.requestBody ? (JSON.parse(row.requestBody) as Json) : undefined;
  } catch {
    // A marker (`[binary body]`, too large) is not a body to send again.
    body = undefined;
  }
  const url = `${origin}${row.path}${row.query ? `?${row.query}` : ''}`;
  return copyAs('curl', { method: row.method, url, headers: [], body });
}

/** A body, JSON tinted by token like every code block in the portal; markers as they are. */
function bodyView(raw: string | null): HTMLElement {
  const text = prettyBody(raw);
  if (text === null) return h('p', { class: 'logs-none xs muted' }, D.noBody);
  const json = text.startsWith('{') || text.startsWith('[');
  const lines: Tok[][] = json
    ? highlightTokens(text, 'json')
    : text.split('\n').map((t) => [{ text: t }]);
  const token = (t: Tok) => (t.cls ? h('span', { class: t.cls }, t.text) : t.text);
  return h(
    'pre',
    { class: 'src', tabindex: '0' },
    h(
      'code',
      {},
      ...lines.map((toks) =>
        h('span', { class: 'ln' }, ...(toks.some((t) => t.text) ? toks.map(token) : [' '])),
      ),
    ),
  );
}

const stampTone = (status: number) => (status >= 500 ? 'bad' : status >= 400 ? 'warn' : 'ok');

/** The exchange as it went over the wire: the request line and its body, the status stamp and its body. */
function exchange(row: RequestLogDetail): HTMLElement {
  const target = `${row.path}${row.query ? `?${row.query}` : ''}`;
  const pane = (label: string, head: HTMLElement[], body: HTMLElement) =>
    h(
      'section',
      { class: 'logs-pane', 'aria-label': label },
      h('header', { class: 'logs-pane-h' }, ...head),
      body,
    );
  const gone = () => h('p', { class: 'logs-none xs muted' }, D.bodiesGone);
  return h(
    'div',
    { class: 'logs-x' },
    pane(
      D.request,
      [
        h('code', { class: 'logs-line', title: target }, `${row.method} ${target}`),
        row.client ? h('span', { class: 'xs muted mono logs-client' }, row.client) : null,
      ].filter((n): n is HTMLElement => n !== null),
      row.hasBodies ? bodyView(row.requestBody) : gone(),
    ),
    pane(
      D.response,
      [
        h('span', { class: `stamp ${stampTone(row.status)}` }, statusText(row.status)),
        h('span', { class: 'xs muted mono' }, duration(row.durationMs)),
      ],
      row.hasBodies ? bodyView(row.responseBody) : gone(),
    ),
  );
}

/** Copy as curl, Open in console, the error's guide entry; then the facts in one muted line. */
function actions(row: RequestLogDetail, link: string | null, keyLabel: string | null): HTMLElement {
  const fact = (...kids: (Node | string)[]) => h('span', { class: 'logs-fact' }, ...kids);
  return h(
    'div',
    { class: 'logs-acts' },
    h(
      'button',
      {
        type: 'button',
        class: 'btn outline sm',
        'data-copy': true,
        'data-copy-text': curlOf(row, location.origin),
      },
      icon('terminal'),
      D.curl,
    ),
    link ? h('a', { class: 'btn outline sm', href: link }, icon('open'), D.console) : null,
    row.code
      ? h(
          'a',
          { class: 'btn outline sm mono', href: `${PATHS.errors}/${encodeURIComponent(row.code)}` },
          icon('book'),
          row.code,
        )
      : null,
    h(
      'p',
      { class: 'logs-facts xs muted' },
      fact(
        h('code', { class: 'mono' }, row.requestId),
        h(
          'button',
          {
            type: 'button',
            class: 'iconbtn copy logs-copy-id',
            'data-copy': true,
            'data-copy-text': row.requestId,
            'aria-label': D.copyId,
          },
          icon('copy'),
        ),
      ),
      keyLabel ? fact(`${D.key} `, h('code', { class: 'mono' }, keyLabel)) : null,
      row.via === 'try' ? fact(row.client === 'portal' ? D.portal : D.via) : null,
      fact(h('time', { datetime: new Date(row.at).toISOString() }, fullTime(row.at))),
      row.bodiesExpireAt ? fact(`${D.expires} ${clock(row.bodiesExpireAt)}`) : null,
    ),
  );
}

/** Fills an opened row: one read of the call with its bodies, and the operation index for the console link. */
export async function openDetail(
  row: RequestLogEntry,
  into: HTMLElement,
  ops: Promise<OpIndex>,
  keyLabel: (keyId: string | null) => string | null,
): Promise<void> {
  fill(into, h('p', { class: 'logs-none xs muted', 'aria-busy': 'true' }, D.loading));
  const [{ body }, index] = await Promise.all([
    getJson<RequestLogDetail>(`${LOG_API}/${row.id}`),
    ops,
  ]);
  if (!body) return fill(into, h('p', { class: 'logs-none sm muted' }, LOGS_COPY.failed));
  fill(
    into,
    exchange(body),
    actions(body, builderLink(index, row.method, row.route), keyLabel(row.keyId)),
  );
}
