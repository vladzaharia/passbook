import { RAIL_COPY } from '../../../shared/copy/developers-ops.ts';
import { loadRail } from '../bench/rail.ts';
import { fill, h } from './dom.ts';
import { count } from './format.ts';
import { icon } from './icons.ts';

const SVG = 'http://www.w3.org/2000/svg';
const W = 96;
const H = 24;

/** The last hour as a line over its own area, the busiest five minutes at the top; flat when it was quiet. */
export function spark(values: readonly number[]): SVGSVGElement {
  const top = Math.max(1, ...values);
  const step = values.length > 1 ? W / (values.length - 1) : 0;
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(H - 2 - (v / top) * (H - 4)).toFixed(1)}`)
    .join(' ');
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({
    class: 'api-spark',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  }))
    svg.setAttribute(k, v);
  const area = document.createElementNS(SVG, 'polygon');
  area.setAttribute('points', `0,${H} ${points} ${W},${H}`);
  const line = document.createElementNS(SVG, 'polyline');
  line.setAttribute('points', points);
  svg.append(area, line);
  return svg;
}

const fact = (cls: string, label: string, visible: boolean, ...value: (Node | string | null)[]) =>
  h(
    'div',
    { class: `api-fact ${cls}` },
    h('dt', { class: visible ? 'xs muted' : 'sr' }, label),
    h('dd', {}, ...value),
  );

/**
 * "Your API" as one strip above the log: the mode and key, the rate tier, the scopes as a count that opens the
 * list, and the last hour as a sparkline beside its count. A row with nothing to say is left out; a missing key is
 * the empty log's to say, once.
 */
export async function mountRail(el: HTMLElement): Promise<void> {
  const { status, body } = await loadRail();
  // Signed out: the prerendered slot stays empty. Signed in, it must never read "Sign in".
  if (status === 401) return;
  const title = h('h2', { class: 'api-t' }, RAIL_COPY.title);
  el.classList.add('card');
  if (status === 404) return fill(el, title, h('p', { class: 'sm muted' }, RAIL_COPY.noSandbox));
  if (!body) return fill(el, title, h('p', { class: 'sm muted' }, RAIL_COPY.failed));

  const chips = h(
    'div',
    { class: 'chips api-scopes', id: 'api-scopes', hidden: true },
    ...body.scopes.map((s) => h('span', { class: 'chip mono' }, s)),
  );
  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'api-more',
      'aria-expanded': 'false',
      'aria-controls': 'api-scopes',
    },
    RAIL_COPY.scopes(body.scopes.length),
    icon('chevron'),
  );
  toggle.addEventListener('click', () => {
    chips.hidden = !chips.hidden;
    toggle.setAttribute('aria-expanded', String(!chips.hidden));
  });
  const test = body.mode === 'test';
  const series = body.series ?? [];
  fill(
    el,
    title,
    h(
      'dl',
      { class: 'api-facts' },
      fact(
        'api-key',
        RAIL_COPY.key,
        false,
        h(
          'span',
          { class: `pill ${test ? 'info' : 'accent'}` },
          test ? RAIL_COPY.test : RAIL_COPY.live,
        ),
        body.key ? h('code', { class: 'mono', title: body.key.name }, body.key.prefix) : null,
      ),
      fact(
        'api-tier',
        RAIL_COPY.tier,
        true,
        `${RAIL_COPY.tiers[body.tier]} · ${count(body.limitPerMinute)} ${RAIL_COPY.perMinute}`,
      ),
      body.scopes.length > 0 ? fact('api-scope', RAIL_COPY.scopesLabel, false, toggle) : null,
      fact(
        'api-calls',
        RAIL_COPY.calls,
        true,
        series.length ? spark(series) : null,
        h('strong', { class: 'mono', 'aria-hidden': 'true' }, count(body.callsLastHour)),
        h('span', { class: 'sr' }, RAIL_COPY.callsLabel(body.callsLastHour)),
      ),
    ),
    body.scopes.length > 0 ? chips : null,
  );
}
