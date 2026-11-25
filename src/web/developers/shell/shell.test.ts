import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXAMPLE_IDS } from '../model/ids.ts';
import { initChangelogFilter } from './filter.ts';
import { initLanguage } from './language.ts';
import { initMenu, revealCurrent } from './menu.ts';
import { initToc } from './toc.ts';

afterEach(() => {
  document.body.innerHTML = '';
  delete document.documentElement.dataset.menu;
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the drawer menu', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<button data-menu-button aria-expanded="false">Menu</button><nav id="dev-menu"><a href="/x">x</a><span id="s">s</span></nav>';
    initMenu();
  });

  it('opens on the button and closes on Escape, handing focus back to the button', () => {
    const button = document.querySelector<HTMLButtonElement>('[data-menu-button]');
    button?.click();
    expect(document.documentElement.dataset.menu).toBe('open');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.documentElement.dataset.menu).toBeUndefined();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('closes when a link in the menu is followed, not for other taps', () => {
    document.querySelector<HTMLButtonElement>('[data-menu-button]')?.click();
    document.querySelector<HTMLElement>('#s')?.click();
    expect(document.documentElement.dataset.menu).toBe('open');
    document.querySelector<HTMLElement>('#dev-menu a')?.click();
    expect(document.documentElement.dataset.menu).toBeUndefined();
  });

  it('does nothing on a page without the button', () => {
    document.body.innerHTML = '';
    expect(() => initMenu()).not.toThrow();
  });
});

describe('the tree', () => {
  it('scrolls the lit page to the middle of its own box, not the sheet chip of the same name', () => {
    document.body.innerHTML =
      '<nav id="dev-menu"><div class="menu-sections"><a aria-current="page" id="chip">R</a></div><a aria-current="page" id="page">P</a></nav>';
    const nav = document.querySelector<HTMLElement>('#dev-menu') as HTMLElement;
    const at = (id: string, top: number) =>
      vi
        .spyOn(document.getElementById(id) as HTMLElement, 'getBoundingClientRect')
        .mockReturnValue({
          top,
        } as DOMRect);
    at('chip', 0);
    at('page', 700);
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(nav, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    Object.defineProperty(nav, 'clientHeight', { value: 400, configurable: true });
    revealCurrent(nav);
    // 700 - 100 below the box top, centred in 400.
    expect(nav.scrollTop).toBe(400);
  });

  it('leaves a hidden tree alone', () => {
    document.body.innerHTML = '<nav id="dev-menu"><a aria-current="page">P</a></nav>';
    const nav = document.querySelector<HTMLElement>('#dev-menu') as HTMLElement;
    vi.spyOn(nav, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
    nav.scrollTop = 7;
    revealCurrent(nav);
    expect(nav.scrollTop).toBe(7);
  });
});

describe('"On this page"', () => {
  const page = () => {
    document.body.innerHTML =
      '<nav data-toc><a href="#a">A</a><a href="#b">B</a><a href="#gone">G</a></nav><h2 id="a">A</h2><h2 id="b">B</h2>';
    const tops: Record<string, number> = { a: -300, b: 90 };
    for (const id of ['a', 'b'])
      vi.spyOn(
        document.getElementById(id) as HTMLElement,
        'getBoundingClientRect',
      ).mockImplementation(() => ({ top: tops[id] }) as DOMRect);
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => f());
    return tops;
  };
  const lit = () =>
    [...document.querySelectorAll('[data-toc] a[aria-current]')].map((a) => a.textContent);

  it('lights the last section whose heading is above the line, on load and on scroll', () => {
    const tops = page();
    initToc();
    expect(lit()).toEqual(['B']);
    tops.b = 400;
    dispatchEvent(new Event('scroll'));
    expect(lit()).toEqual(['A']);
  });

  it('lights the first section before any heading has passed, and ignores entries without a heading', () => {
    const tops = page();
    tops.a = 300;
    tops.b = 600;
    initToc();
    expect(lit()).toEqual(['A']);
  });

  it('does nothing on a page without the list', () => {
    document.body.innerHTML = '';
    expect(() => initToc()).not.toThrow();
  });
});

describe('the language picker', () => {
  const page = () => {
    document.body.innerHTML =
      '<input type="radio" name="a" data-lang="ts"><input type="radio" name="a" data-lang="py"><input type="radio" name="b" data-lang="ts"><input type="radio" name="b" data-lang="py"><button id="plain"></button>';
  };
  const checked = () =>
    [...document.querySelectorAll<HTMLInputElement>('input')].map((i) => i.checked);

  it('starts on the remembered language', () => {
    page();
    localStorage.setItem('passbook-dev-lang', 'py');
    initLanguage();
    expect(checked()).toEqual([false, true, false, true]);
  });

  it('makes every sample follow the choice and remembers it', () => {
    page();
    initLanguage();
    const first = document.querySelector<HTMLInputElement>('input[data-lang="py"]');
    if (first) first.checked = true;
    first?.dispatchEvent(new Event('change', { bubbles: true }));
    expect(checked()).toEqual([false, true, false, true]);
    expect(localStorage.getItem('passbook-dev-lang')).toBe('py');
    document.getElementById('plain')?.dispatchEvent(new Event('change', { bubbles: true }));
    expect(localStorage.getItem('passbook-dev-lang')).toBe('py');
  });

  it('works for the page when storage is blocked', () => {
    page();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    initLanguage();
    const input = document.querySelector<HTMLInputElement>('input[data-lang="py"]');
    input?.dispatchEvent(new Event('change', { bubbles: true }));
    expect(checked()).toEqual([false, true, false, true]);
  });
});

describe('the changelog filter', () => {
  const page = () => {
    document.body.innerHTML = `<div data-changelog>
      <select data-area-filter hidden><option value="">All</option><option value="Passes">Passes</option></select>
      <section class="cl-day" id="d1"><div class="cl-item" data-area="Passes"></div></section>
      <section class="cl-day" id="d2"><div class="cl-item" data-area="Templates"></div></section>
    </div>`;
  };

  it('shows the select and hides rows and days of other resources', () => {
    page();
    initChangelogFilter();
    const select = document.querySelector<HTMLSelectElement>('select');
    expect(select?.hidden).toBe(false);
    if (select) select.value = 'Passes';
    select?.dispatchEvent(new Event('change'));
    expect(document.querySelector<HTMLElement>('#d1')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#d2')?.hidden).toBe(true);
    if (select) select.value = '';
    select?.dispatchEvent(new Event('change'));
    expect(document.querySelector<HTMLElement>('#d2')?.hidden).toBe(false);
  });

  it('does nothing without the filter markup', () => {
    document.body.innerHTML = '<div></div>';
    expect(() => initChangelogFilter()).not.toThrow();
  });
});

describe('personal snippets', () => {
  const load = async (response: Response | Error) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/session'))
          return json({ authenticated: true, csrfToken: 'c', roles: ['developer'] });
        if (response instanceof Error) throw response;
        return response.clone();
      }),
    );
    vi.resetModules();
    document.body.innerHTML = `<div data-samples><code id="in">org ${EXAMPLE_IDS.orgId} tpl ${EXAMPLE_IDS.templateId}</code></div><p id="out">${EXAMPLE_IDS.orgId}</p>`;
    const { mount } = await import('./personal.ts');
    await mount();
    return document.getElementById('in')?.textContent;
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('swaps the example ids in samples for the reader sandbox, and only in samples', async () => {
    const text = await load(json({ sandbox: { orgId: 'org-mine', templateId: 'tpl-mine' } }));
    expect(text).toBe('org org-mine tpl tpl-mine');
    expect(document.getElementById('out')?.textContent).toBe(EXAMPLE_IDS.orgId);
  });

  it('keeps the org swap when no template exists yet', async () => {
    const text = await load(json({ sandbox: { orgId: 'org-mine', templateId: null } }));
    expect(text).toBe(`org org-mine tpl ${EXAMPLE_IDS.templateId}`);
  });

  it.each([
    ['signed out', json({}, 401)],
    ['no sandbox', json({ sandbox: null })],
    ['offline', new Error('offline')],
  ])('leaves the examples as written when %s', async (_name, response) => {
    const text = await load(response);
    expect(text).toBe(`org ${EXAMPLE_IDS.orgId} tpl ${EXAMPLE_IDS.templateId}`);
  });

  it('asks nothing of the sandbox endpoint when there is no session', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => json({ authenticated: false }));
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    document.body.innerHTML = '<div data-samples><code>org</code></div>';
    await (await import('./personal.ts')).mount();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/v1/session']);
  });
});
