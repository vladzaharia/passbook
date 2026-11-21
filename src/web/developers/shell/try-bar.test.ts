import { afterEach, describe, expect, it, vi } from 'vitest';

const openSheet = vi.fn();
vi.mock('./sheet.ts', () => ({ openSheet: (...a: unknown[]) => openSheet(...a) }));

afterEach(() => {
  document.body.innerHTML = '';
  openSheet.mockReset();
  vi.unstubAllGlobals();
  vi.resetModules();
});

type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;
function observer() {
  let cb: Callback = () => {};
  class Fake {
    constructor(c: Callback) {
      cb = c;
    }
    observe() {}
  }
  vi.stubGlobal('IntersectionObserver', Fake);
  return (entries: Partial<IntersectionObserverEntry>[]) => cb(entries);
}

const page = () => {
  document.body.innerHTML = `<a data-try-bar href="#a">Try it</a>
    <section class="op" id="op1"><div class="try" id="a"></div></section>
    <section class="op" id="op2"><div class="try" id="b"></div></section>`;
  return document.querySelector<HTMLAnchorElement>('[data-try-bar]') as HTMLAnchorElement;
};

describe('the Try it bar', () => {
  it('points at the first operation on screen', async () => {
    const fire = observer();
    const link = page();
    const { initTryBar } = await import('./try-bar.ts');
    initTryBar();
    fire([{ target: document.getElementById('op2') as Element, isIntersecting: true }]);
    expect(link.getAttribute('href')).toBe('#b');
    fire([
      { target: document.getElementById('op1') as Element, isIntersecting: true },
      { target: document.getElementById('op2') as Element, isIntersecting: false },
    ]);
    expect(link.getAttribute('href')).toBe('#a');
  });

  it('opens the sheet on a phone, and leaves the link alone elsewhere', async () => {
    const fire = observer();
    const link = page();
    const { initTryBar } = await import('./try-bar.ts');
    initTryBar();
    fire([{ target: document.getElementById('op2') as Element, isIntersecting: true }]);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const wide = new MouseEvent('click', { cancelable: true });
    link.dispatchEvent(wide);
    expect(wide.defaultPrevented).toBe(false);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const phone = new MouseEvent('click', { cancelable: true });
    link.dispatchEvent(phone);
    expect(phone.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(openSheet).toHaveBeenCalledWith(document.getElementById('b')));
  });

  it('does nothing without the bar, the slots or IntersectionObserver', async () => {
    const { initTryBar } = await import('./try-bar.ts');
    document.body.innerHTML = '<div></div>';
    expect(() => initTryBar()).not.toThrow();
    page();
    vi.stubGlobal('IntersectionObserver', undefined);
    delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
    expect(() => initTryBar()).not.toThrow();
  });
});
