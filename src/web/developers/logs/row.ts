import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { h } from './dom.ts';
import { clock, flavour } from './format.ts';
import { icon } from './icons.ts';
import {
  duration,
  durationShare,
  fullTime,
  type PathRun,
  pathParts,
  SLOW_MS,
} from './row-format.ts';

const methodClass = (m: string) => `method ${m === 'DELETE' ? 'del' : m.toLowerCase()}`;
const runsOf = (cls: string, runs: PathRun[]) =>
  h(
    'span',
    { class: cls },
    ...runs.map((r) => (r.id ? h('span', { class: 'logs-id' }, r.text) : r.text)),
  );

/** Where a call came from, when it was not your key: Run here, or the portal reading for itself. */
function via(row: RequestLogEntry): HTMLElement | null {
  if (row.via !== 'try') return null;
  const label = row.client === 'portal' ? LOGS_COPY.detail.portal : LOGS_COPY.detail.via;
  return h(
    'span',
    { class: 'logs-via', title: label },
    icon('monitor'),
    h('span', { class: 'sr' }, label),
  );
}

/** The duration and its bar: log scale, full at 3 s; a call over a second is marked. */
function timing(ms: number): HTMLElement {
  const fill = h('span', { class: 'logs-fill' });
  fill.style.setProperty('--w', durationShare(ms).toFixed(3));
  return h(
    'span',
    { class: 'logs-ms', 'data-slow': ms >= SLOW_MS },
    h('span', { class: 'logs-track', 'aria-hidden': 'true' }, fill),
    h('span', { class: 'mono' }, duration(ms)),
  );
}

/**
 * One request on one line: time (seconds today, the date before), method, the path cut in the middle with the whole
 * of it in the title, the error code, the status by class and the duration. A details row: click or Enter opens it,
 * and `open` fills the detail the first time.
 */
export function rowView(
  row: RequestLogEntry,
  open: (row: RequestLogEntry, into: HTMLElement) => void,
  now = Date.now(),
): HTMLDetailsElement {
  const tone = flavour(row.status);
  const { full, head, tail } = pathParts(row.path, row.query);
  const detail = h('div', { class: 'logs-detail' });
  const el = h(
    'details',
    {
      class: 'logs-row',
      'data-id': row.id,
      'data-request-id': row.requestId.toLowerCase(),
      'data-tone': tone,
    },
    h(
      'summary',
      { class: 'logs-sum' },
      h(
        'time',
        {
          class: 'mono logs-time',
          datetime: new Date(row.at).toISOString(),
          title: fullTime(row.at),
        },
        clock(row.at, now),
      ),
      h('span', { class: methodClass(row.method) }, row.method === 'DELETE' ? 'DEL' : row.method),
      h(
        'span',
        { class: 'logs-where', title: full },
        h('code', { class: 'logs-path' }, runsOf('logs-head', head), runsOf('logs-tail', tail)),
        row.code ? h('code', { class: 'logs-code' }, row.code) : null,
        via(row),
      ),
      h('span', { class: `pill ${tone} mono logs-status` }, String(row.status)),
      timing(row.durationMs),
    ),
    detail,
  );
  let filled = false;
  el.addEventListener('toggle', () => {
    if (!el.open || filled) return;
    filled = true;
    open(row, detail);
  });
  return el;
}
