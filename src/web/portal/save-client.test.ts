import { afterEach, describe, expect, it, vi } from 'vitest';
import { PASS_SAVE_SOURCE } from '../../shared/pass-offline.ts';
import { clearAll, mount } from './save-client.ts';

const TOKEN = 'abcdefghijklmnop0123';
const PATH = `/p/${TOKEN}/barcode`;

function stubBrowser(
  over: { tt?: unknown; regs?: { scope: string; unregister(): Promise<boolean> }[] } = {},
) {
  const stores = new Map<string, Map<string, Response>>();
  vi.stubGlobal('caches', {
    open: async (n: string) => ({
      put: async (k: string, r: Response) => {
        if (!stores.has(n)) stores.set(n, new Map());
        stores.get(n)?.set(k, r);
      },
    }),
    has: async (n: string) => stores.has(n),
    delete: async (n: string) => stores.delete(n),
    keys: async () => [...stores.keys()],
  });
  const reg = {
    installing: null,
    waiting: null,
    active: { state: 'activated' },
    scope: `${location.origin}${PATH}`,
    unregister: vi.fn(async () => true),
  };
  const register = vi.fn(async () => reg);
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register,
      getRegistration: async () => reg,
      getRegistrations: async () => over.regs ?? [reg],
    },
  });
  vi.stubGlobal(
    'fetch',
    async () => new Response('door', { headers: { 'x-pass-expires-at': '4102444800000' } }),
  );
  if (over.tt) vi.stubGlobal('trustedTypes', over.tt);
  return { stores, register, reg };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the app save client', () => {
  it('saves through a passbook-save policy that admits only /p/sw.js, then removes', async () => {
    const rules: { createScriptURL?: (u: string) => string } = {};
    const tt = {
      createPolicy: vi.fn((_n: string, r: typeof rules) => {
        Object.assign(rules, r);
        return { createScriptURL: (u: string) => r.createScriptURL?.(u) };
      }),
    };
    const { stores, register } = stubBrowser({ tt });
    document.body.innerHTML = `<div data-save-phone="${PATH}"><a data-save-do href="#">Save</a><button data-save-drop>Remove</button></div>`;
    mount();
    const host = document.querySelector('[data-save-phone]') as HTMLElement;
    (host.querySelector('[data-save-do]') as HTMLElement).click();
    await vi.waitFor(() => expect(host.getAttribute('data-save')).toBe('saved'));
    expect(tt.createPolicy.mock.calls[0]?.[0]).toBe('passbook-save');
    expect(register).toHaveBeenCalledWith('/p/sw.js', { scope: PATH });
    expect(() => rules.createScriptURL?.('/x.js')).toThrow(TypeError);
    expect(stores.size).toBe(1);
    (host.querySelector('[data-save-drop]') as HTMLElement).click();
    await vi.waitFor(() => expect(stores.size).toBe(0));
  });

  it('refuses another origin or path, and clears every copy and door worker on sign-out', async () => {
    const { stores, reg } = stubBrowser();
    document.body.innerHTML =
      '<div data-save-phone="https://evil.test/p/abcdefghijklmnop0123/barcode"></div>';
    mount();
    expect(document.querySelector('[data-save-ready]')).toBeNull();
    stores.set('barcode:x', new Map());
    stores.set('other', new Map());
    await clearAll();
    expect([...stores.keys()]).toEqual(['other']);
    expect(reg.unregister).toHaveBeenCalled();
  });

  it('writes the same cache, key and entry as the /p script (parity)', async () => {
    const entries: Record<string, [string, string, string, [string, string][]]> = {};
    for (const impl of ['client', 'script'] as const) {
      const { stores } = stubBrowser();
      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      document.body.innerHTML = `<div data-save-phone="${PATH}"><a data-save-do href="#">Save</a></div>`;
      if (impl === 'client') mount();
      else {
        (window as unknown as { PassSave?: unknown }).PassSave = undefined;
        new Function(PASS_SAVE_SOURCE)();
      }
      const host = document.querySelector('[data-save-phone]') as HTMLElement;
      (host.querySelector('[data-save-do]') as HTMLElement).click();
      await vi.waitFor(() => expect(host.getAttribute('data-save')).toBe('saved'));
      const [[name, entry]] = [...stores.entries()].map(
        ([n, m]) => [n, [...m.entries()][0]] as const,
      );
      const [key, res] = entry as [string, Response];
      entries[impl] = [
        name,
        key,
        await res.text(),
        [...res.headers.entries()].filter(([k]) => k !== 'x-saved-at').sort(),
      ];
      document.body.innerHTML = '';
      vi.unstubAllGlobals();
    }
    expect(entries.script).toEqual(entries.client);
    expect(entries.client?.[3]).toContainEqual(['x-expires-at', '4102444800000']);
  });
});
