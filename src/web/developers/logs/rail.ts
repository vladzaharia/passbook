import type { ApiRail } from '../../../shared/contracts/developer.ts';
import { RAIL_COPY } from '../../../shared/copy/developers-ops.ts';
import { fill, getJson, h } from './dom.ts';
import { count } from './format.ts';

const row = (label: string, ...value: (Node | string)[]) =>
  h('div', { class: 'rail-row' }, h('dt', { class: 'xs muted' }, label), h('dd', {}, ...value));

/** "Your API": the sandbox key's mode, scopes and tier, and the calls of the last hour. */
export async function mountRail(el: HTMLElement): Promise<void> {
  const { status, body } = await getJson<ApiRail>('/api/v1/developer/rail');
  // Signed out: the prerendered placeholder stays. Signed in, it must never read "Sign in".
  if (status === 401) return;
  if (status === 404)
    return fill(
      el,
      h('h3', { class: 'h3' }, RAIL_COPY.title),
      h('p', { class: 'sm muted' }, RAIL_COPY.noSandbox),
    );
  if (!body)
    return fill(
      el,
      h('h3', { class: 'h3' }, RAIL_COPY.title),
      h('p', { class: 'sm muted' }, RAIL_COPY.failed),
    );
  fill(
    el,
    h('h3', { class: 'h3' }, RAIL_COPY.title),
    body.key
      ? h('code', { class: 'mono xs muted' }, `${body.key.name} · ${body.key.prefix}`)
      : h('p', { class: 'sm muted' }, RAIL_COPY.noKey),
    h(
      'dl',
      { class: 'rail-list' },
      row(
        RAIL_COPY.mode,
        h(
          'span',
          { class: `pill ${body.mode === 'test' ? 'info' : 'accent'}` },
          body.mode === 'test' ? 'Test' : 'Live',
        ),
      ),
      row(
        RAIL_COPY.scopes,
        h(
          'span',
          { class: 'chips' },
          ...body.scopes.map((s) => h('span', { class: 'chip mono' }, s)),
        ),
      ),
      row(RAIL_COPY.tier, `${body.tier} · ${count(body.limitPerMinute)} ${RAIL_COPY.perMinute}`),
      row(RAIL_COPY.calls, h('strong', {}, count(body.callsLastHour))),
    ),
  );
}
