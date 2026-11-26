import { afterEach, describe, expect, it, vi } from 'vitest';
import { RAIL_COPY } from '../../../shared/copy/developers-ops.ts';
import { forgetRail, loadRail } from '../bench/rail.ts';
import { h } from './dom.ts';
import { mountRail, spark } from './rail.ts';
import { json, rail } from './test-support.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const mount = async (res: Response) => {
  forgetRail();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => res),
  );
  const el = h('div', {});
  await mountRail(el);
  return el;
};

describe('the Your API strip', () => {
  it('reads the rail once per page', async () => {
    forgetRail();
    const fetchMock = vi.fn(async () => json(rail));
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([loadRail(), loadRail()]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('stays an empty slot when signed out, and says there is no sandbox or that it failed', async () => {
    expect((await mount(json({}, 401))).childElementCount).toBe(0);
    expect((await mount(json({}, 404))).textContent).toBe(
      `${RAIL_COPY.title}${RAIL_COPY.noSandbox}`,
    );
    expect((await mount(json({}, 500))).textContent).toContain(RAIL_COPY.failed);
  });

  it('puts the heading after the page title in order (h2), then mode, key, tier, scopes and the last hour', async () => {
    const el = await mount(json(rail));
    expect(el.querySelector('h2')?.textContent).toBe(RAIL_COPY.title);
    expect(el.querySelector('.pill')?.textContent).toBe(RAIL_COPY.test);
    expect(el.querySelector('.api-key code')?.textContent).toBe('pb_test_ab12');
    expect(el.querySelector('.api-tier dd')?.textContent).toBe('Standard · 1,200 a minute');
    expect(el.querySelector('.api-calls strong')?.textContent).toBe('3,456');
    expect(el.querySelector('.api-calls')?.textContent).toContain(RAIL_COPY.callsLabel(3456));
    expect(el.querySelectorAll('.api-spark polyline')).toHaveLength(1);
  });

  it('collapses the scopes to a count that opens the list', async () => {
    const el = await mount(json(rail));
    const toggle = el.querySelector<HTMLButtonElement>('.api-more');
    const chips = el.querySelector<HTMLElement>('.api-scopes');
    expect(toggle?.textContent).toBe(RAIL_COPY.scopes(2));
    expect(toggle?.getAttribute('aria-controls')).toBe(chips?.id);
    expect(chips?.hidden).toBe(true);
    toggle?.click();
    expect(chips?.hidden).toBe(false);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect([...el.querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(rail.scopes);
  });

  it('leaves out what it has nothing for: no scopes, no key, no series', async () => {
    const { series: _, ...old } = rail;
    const el = await mount(json({ ...old, mode: 'live', scopes: [], key: null }));
    expect(el.querySelector('.api-scope')).toBeNull();
    expect(el.querySelector('.api-scopes')).toBeNull();
    expect(el.querySelector('.api-key code')).toBeNull();
    expect(el.querySelector('.api-spark')).toBeNull();
    expect(el.querySelector('.pill')?.textContent).toBe(RAIL_COPY.live);
  });
});

describe('the sparkline', () => {
  const ys = (svg: SVGSVGElement) =>
    (svg.querySelector('polyline')?.getAttribute('points') ?? '')
      .split(' ')
      .map((p) => Number(p.split(',')[1]));

  it('puts the busiest five minutes at the top, and lies flat when it was quiet', () => {
    const busy = ys(spark([0, 4, 2]));
    expect(Math.min(...busy)).toBe(busy[1]);
    expect(new Set(ys(spark([0, 0, 0]))).size).toBe(1);
  });
});
