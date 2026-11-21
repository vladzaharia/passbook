import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXAMPLE_IDS } from '../model/ids.ts';
import { initChangelogFilter } from './filter.ts';
import { initLanguage } from './language.ts';
import { initMenu } from './menu.ts';

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
      vi.fn(async () => {
        if (response instanceof Error) throw response;
        return response;
      }),
    );
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
});
