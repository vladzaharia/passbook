import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { choose, entry, json, open, page, rail, rowsOf } from './test-support.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const F = LOGS_COPY.filters;
const clearButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.logs-clear');
const select = (el: HTMLElement, name: string) =>
  el.querySelector<HTMLSelectElement>(`select[name="${name}"]`);

describe('the filter row', () => {
  it('reads "Label: value" for each select, path search first, and Clear only when something is set', async () => {
    const { el } = await open([page([entry(1)])]);
    const bar = el.querySelector('search.logs-bar');
    expect(bar?.firstElementChild?.querySelector('input[type="search"]')).not.toBeNull();
    const shown = (k: Element) =>
      `${k.querySelector('.ksel-l')?.textContent}${k.querySelector('.ksel-v')?.textContent}`;
    const labels = [...el.querySelectorAll('.ksel')].map(shown);
    expect(labels).toEqual([
      `${F.status}:${F.any}`,
      `${F.method}:${F.any}`,
      `${F.code}:${F.any}`,
      `${F.source}:Yours`,
    ]);
    expect(clearButton(el)?.hidden).toBe(true);
    choose(el, 'status', '4xx');
    expect(clearButton(el)?.hidden).toBe(false);
    const set = el.querySelector('.ksel[data-set]');
    expect(set && shown(set)).toBe(`${F.status}:4xx`);
    expect(el.querySelector('.logs-note')?.textContent).toBe(LOGS_COPY.retention);
  });

  it('filters after a short pause, then Clear goes back to Yours', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { el, calls } = await open([page([entry(1)]), page([entry(2)]), page([entry(1)])]);
    choose(el, 'status', '4xx');
    choose(el, 'method', 'GET');
    choose(el, 'source', 'all');
    const path = el.querySelector<HTMLInputElement>('input[name="path"]');
    if (path) path.value = ' /passes ';
    path?.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    const last = new URL(calls.at(-1) ?? '', location.origin).searchParams;
    expect(Object.fromEntries(last)).toEqual({
      status: '4xx',
      method: 'GET',
      path: '/passes',
      source: 'all',
    });
    expect(rowsOf(el)[0]?.dataset.id).toBe('log-2');
    clearButton(el)?.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.at(-1)).toMatch(/\?source=key$/);
    expect(clearButton(el)?.hidden).toBe(true);
  });

  it('lists the codes it has seen in Code, and is off until there is one', async () => {
    const { el } = await open([page([entry(1)])]);
    expect(select(el, 'code')?.disabled).toBe(true);
    const withCodes = await open([
      page([entry(1, { code: 'PASS_VOIDED' }), entry(2, { code: 'INVALID_INPUT' })]),
    ]);
    const code = select(withCodes.el, 'code');
    expect(code?.disabled).toBe(false);
    expect([...(code?.options ?? [])].map((o) => o.value)).toEqual([
      '',
      'INVALID_INPUT',
      'PASS_VOIDED',
    ]);
  });

  it('asks nothing for a filter change that lands after the log left the page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { el, calls } = await open([page([entry(1)])]);
    const before = calls.length;
    choose(el, 'status', '4xx');
    el.remove();
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(before);
  });
});

describe('an empty log', () => {
  it('waits for the first call: the buddy, a curl to copy, Run in console, and no toolbar', async () => {
    const { el } = await open([page([])]);
    await vi.waitFor(() => expect(el.querySelector('.logs-first')).not.toBeNull());
    expect(el.querySelector('.logs-first h2')?.textContent).toBe(LOGS_COPY.empty.title);
    expect(el.querySelector('.logs-first [data-buddy]')).not.toBeNull();
    const code = [...el.querySelectorAll('.logs-curl .ln')].map((l) => l.textContent).join('\n');
    expect(code).toContain(`curl ${location.origin}/api/v1/passes?limit=1`);
    expect(code).toContain('Bearer $PASSBOOK_KEY');
    expect(el.querySelector('.logs-first a.btn')?.getAttribute('href')).toBe('/developers/console');
    expect(el.querySelector<HTMLElement>('.logs-bar')?.hidden).toBe(true);
    expect(el.querySelector<HTMLElement>('.logs-list')?.hidden).toBe(true);
    expect(el.querySelector<HTMLElement>('.logs-foot')?.hidden).toBe(true);
    expect(el.querySelector('.logs-foot button:not([hidden])')).toBeNull();
  });

  it('says once that the sandbox has no key, with the way to make one and no curl', async () => {
    const { el } = await open([page([])], { rail: json({ ...rail, key: null }) });
    await vi.waitFor(() => expect(el.textContent).toContain(LOGS_COPY.empty.noKey));
    expect(el.querySelector('.logs-curl')).toBeNull();
    expect(el.querySelector('.logs-first a.btn')?.getAttribute('href')).toBe('/developers/keys');
    expect(document.body.textContent?.split(LOGS_COPY.empty.noKey)).toHaveLength(2);
  });

  it('offers the portal’s calls when only the portal has called', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { el, calls } = await open([page([]), page([entry(1, { via: 'try' })])], {
      portal: page([entry(9, { via: 'try' })]),
    });
    const show = await vi.waitFor(() => {
      const b = [...el.querySelectorAll('button')].find(
        (x) => x.textContent === LOGS_COPY.empty.showHidden,
      );
      if (!b) throw new Error('not yet');
      return b;
    });
    expect(el.textContent).toContain('1 call from the portal is hidden.');
    expect(el.textContent).not.toContain(LOGS_COPY.empty.title);
    show.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.at(-1)).toContain('source=try');
    expect(rowsOf(el)).toHaveLength(1);
    expect(el.querySelector<HTMLElement>('.logs-bar')?.hidden).toBe(false);
  });

  it('tells no match from empty, and Clear filters brings the rows back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { el } = await open([page([entry(1)]), page([]), page([entry(1)])]);
    choose(el, 'method', 'PUT');
    await vi.advanceTimersByTimeAsync(300);
    expect(el.querySelector('.logs-nomatch')?.textContent).toContain(LOGS_COPY.empty.noMatch);
    expect(el.querySelector<HTMLElement>('.logs-bar')?.hidden).toBe(false);
    [...el.querySelectorAll('button')]
      .find((b) => b.textContent === LOGS_COPY.empty.clear)
      ?.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(rowsOf(el)).toHaveLength(1);
    expect(el.querySelector('.logs-nomatch')).toBeNull();
  });

  it('keeps the rows on a failed refetch and says it failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { el } = await open([page([entry(1)]), json({}, 500)]);
    choose(el, 'method', 'GET');
    await vi.advanceTimersByTimeAsync(300);
    expect(el.querySelector('.logs-list')?.textContent).toBe(LOGS_COPY.failed);
    expect(el.querySelector('.logs-list')?.hasAttribute('aria-busy')).toBe(false);
  });
});
