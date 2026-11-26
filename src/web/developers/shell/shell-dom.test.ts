import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyToClipboard, initCopy } from './copy.ts';
import { ISLANDS, mountIslands } from './islands.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const clipboard = (writeText: (t: string) => Promise<void>) =>
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

describe('copy buttons', () => {
  // initCopy listens on the document for good: one call serves the whole file.
  beforeAll(() => initCopy());
  const click = async (selector: string) => {
    const el = document.querySelector<HTMLElement>(selector);
    el?.click();
    await vi.waitFor(() => expect(el?.dataset.state).toBeDefined());
    return el as HTMLElement;
  };

  it('copyToClipboard says whether the text is on the clipboard', async () => {
    clipboard(async () => {});
    expect(await copyToClipboard('x')).toBe(true);
    clipboard(async () => {
      throw new Error('denied');
    });
    expect(await copyToClipboard('x')).toBe(false);
  });

  it('copies a button own text, marks it copied and resets after a moment', async () => {
    const written: string[] = [];
    clipboard(async (t) => {
      written.push(t);
    });
    document.body.innerHTML =
      '<button data-copy data-copy-text="curl x" aria-label="Copy">c</button>';
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const button = await click('[data-copy]');
    expect(written).toEqual(['curl x']);
    expect(button.dataset.state).toBe('copied');
    // The name stays put; the one live region says what happened.
    expect(button.getAttribute('aria-label')).toBe('Copy');
    vi.advanceTimersByTime(100);
    expect(document.querySelectorAll('[role="status"]#dev-live')).toHaveLength(1);
    expect(document.getElementById('dev-live')?.textContent).toBe('Copied');
    vi.advanceTimersByTime(1600);
    expect(button.dataset.state).toBeUndefined();
  });

  it('copies the endpoint, the command and the visible lines of a sample', async () => {
    const written: string[] = [];
    clipboard(async (t) => {
      written.push(t);
    });
    document.body.innerHTML = `
      <div class="endpoint"><code>POST /passes</code><button data-copy id="a" aria-label="Copy path"></button></div>
      <div class="cmd"><code>npm i</code><button data-copy id="b" aria-label="Copy command"></button></div>
      <div data-samples>
        <div data-panel="ts"><span class="ln">one</span><span class="ln">two</span></div>
        <button data-copy id="c" aria-label="Copy code"></button>
      </div>
      <button data-copy id="d" aria-label="Copy"></button>`;
    for (const id of ['a', 'b', 'c', 'd']) {
      document.getElementById(id)?.click();
      await vi.waitFor(() => expect(document.getElementById(id)?.dataset.state).toBe('copied'));
    }
    expect(written).toEqual(['POST /passes', 'npm i', 'one\ntwo', '']);
  });

  it('copy as: one language, or the open one fenced as Markdown', async () => {
    const written: string[] = [];
    clipboard(async (t) => {
      written.push(t);
    });
    document.body.innerHTML = `
      <div data-samples>
        <input type="radio" data-lang="py" checked>
        <div data-panel="ts"><span class="ln">const a = 1</span></div>
        <div data-panel="py"><span class="ln">a = 1</span><span class="ln">b = 2</span></div>
        <button data-copy-as="ts" id="ts">TypeScript</button>
        <button data-copy-as="md" id="md">Markdown</button>
        <button data-copy-as="go" id="go">Go</button>
      </div>`;
    for (const id of ['ts', 'md', 'go']) {
      document.getElementById(id)?.click();
      await vi.waitFor(() => expect(document.getElementById(id)?.dataset.state).toBe('copied'));
    }
    expect(written).toEqual(['const a = 1', '```py\na = 1\nb = 2\n```', '']);
  });

  it('opens and closes the Copy as menu, wraps long lines', async () => {
    clipboard(async () => {});
    document.body.innerHTML = `
      <div class="code" data-samples>
        <div class="menu">
          <button data-menu-toggle aria-expanded="false" id="t">Copy as</button>
          <div class="menu-list" hidden><button data-copy-as="md" id="pick">Markdown</button></div>
        </div>
        <button class="copy" data-copy data-copy-text="x" id="c">c</button>
        <button data-wrap-toggle aria-pressed="false" id="w">Wrap</button>
      </div>`;
    const list = document.querySelector('.menu-list') as HTMLElement;
    document.getElementById('t')?.click();
    expect(list.hidden).toBe(false);
    expect(document.getElementById('t')?.getAttribute('aria-expanded')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(list.hidden).toBe(true);
    document.getElementById('t')?.click();
    document.getElementById('pick')?.click();
    await vi.waitFor(() => expect(document.getElementById('c')?.dataset.state).toBe('copied'));
    expect(list.hidden).toBe(true);
    document.getElementById('w')?.click();
    expect(document.querySelector('.code')?.hasAttribute('data-wrap')).toBe(true);
    expect(document.getElementById('w')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('says so when the clipboard refuses', async () => {
    clipboard(async () => {
      throw new Error('denied');
    });
    document.body.innerHTML = '<button data-copy data-copy-text="x" aria-label="Copy">c</button>';
    const button = await click('[data-copy]');
    expect(button.dataset.state).toBe('failed');
    await vi.waitFor(() =>
      expect(document.getElementById('dev-live')?.textContent).toMatch(/Could not copy/),
    );
  });
});

describe('islands', () => {
  type Entry = IntersectionObserverEntry;
  const observe = (impl: (cb: (entries: Partial<Entry>[]) => void) => void) => {
    const observed: Element[] = [];
    const unobserved: Element[] = [];
    class FakeObserver {
      constructor(cb: (entries: Partial<Entry>[]) => void) {
        impl(cb);
        this.cb = cb;
      }
      cb: (entries: Partial<Entry>[]) => void;
      observe(el: Element) {
        observed.push(el);
        this.cb([{ target: el, isIntersecting: true }]);
      }
      unobserve(el: Element) {
        unobserved.push(el);
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    return { observed, unobserved };
  };

  it('registers every island by name', () => {
    expect(Object.keys(ISLANDS).sort()).toEqual([
      'account',
      'api-rail',
      'bench-strip',
      'hero-start',
      'keys',
      'logs',
      'moved',
      'operations',
      'org-chip',
      'playground',
      'quickstart',
      'run',
      'snippets',
      'webhook-tester',
      'workbench',
    ]);
  });

  it('mounts an island once when its element comes into view', async () => {
    const mount = vi.fn();
    const original = ISLANDS['test-island'];
    ISLANDS['test-island'] = async () => ({ mount });
    const seen = observe(() => {});
    document.body.innerHTML =
      '<div data-island="test-island" id="x"></div><div data-island="unknown"></div><div></div>';
    mountIslands();
    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(1));
    expect(mount.mock.calls[0]?.[0]).toBe(document.getElementById('x'));
    expect(seen.observed).toHaveLength(1);
    expect(seen.unobserved).toEqual([document.getElementById('x')]);
    if (original) ISLANDS['test-island'] = original;
    else delete ISLANDS['test-island'];
  });

  it('holds the account slot until its island has mounted', async () => {
    const original = ISLANDS.account;
    let release: () => void = () => {};
    ISLANDS.account = async () => ({
      mount: () =>
        new Promise<void>((done) => {
          release = done;
        }),
    });
    observe(() => {});
    document.body.innerHTML =
      '<span data-island="account" id="a"><a href="/login">Sign in</a></span>';
    const slot = document.getElementById('a') as HTMLElement;
    mountIslands();
    expect(slot.hasAttribute('data-ready')).toBe(false);
    await vi.waitFor(() => expect(release).not.toBe(undefined));
    await new Promise((r) => setTimeout(r, 0));
    expect(slot.hasAttribute('data-ready')).toBe(false);
    release();
    await vi.waitFor(() => expect(slot.hasAttribute('data-ready')).toBe(true));
    ISLANDS.account = original as NonNullable<typeof original>;
  });

  it('shows the account slot again, and reports the error, when the island fails to load or mount', async () => {
    const original = ISLANDS.account;
    const reported: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      e.preventDefault();
      reported.push(e.error);
    };
    window.addEventListener('error', onError);
    observe(() => {});
    for (const fail of ['load', 'mount'] as const) {
      ISLANDS.account = async () => {
        if (fail === 'load') throw new Error('chunk failed');
        return {
          mount: async () => {
            throw new Error('mount failed');
          },
        };
      };
      document.body.innerHTML = '<span data-island="account"><a href="/login">Sign in</a></span>';
      const slot = document.querySelector<HTMLElement>('[data-island="account"]') as HTMLElement;
      mountIslands();
      expect(slot.hasAttribute('data-ready')).toBe(false);
      await vi.waitFor(() => expect(slot.hasAttribute('data-ready')).toBe(true));
      expect(slot.querySelector('a')?.textContent).toBe('Sign in');
    }
    expect(reported.map((e) => (e as Error).message)).toEqual(['chunk failed', 'mount failed']);
    window.removeEventListener('error', onError);
    ISLANDS.account = original as NonNullable<typeof original>;
  });

  it('does not wait for the observer when none is registered or supported', () => {
    const seen = observe(() => {});
    document.body.innerHTML = '<div data-island="unknown"></div>';
    mountIslands();
    expect(seen.observed).toHaveLength(0);
  });
});
