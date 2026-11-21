import { PASS_SW_PATH, SAVE_POLICY } from '../../shared/pass-offline.ts';

/**
 * The app's copy of the save controls (/p's is the script served at /p/save.js, built from
 * shared/pass-offline.ts; the two make the same cache name, key and entry, and the unit tests drive
 * both). Loaded lazily by SaveMount, so only a pass page that offers Save carries it.
 * `passbook-save` is made here and nowhere else in the app.
 */
/** The browser parts used here, typed by hand: the worker project (which SSR-imports this tree) has no DOM lib. */
interface El {
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  removeAttribute(n: string): void;
  hasAttribute(n: string): boolean;
  querySelector(s: string): (El & { showModal?(): void; close?(): void }) | null;
  querySelectorAll(s: string): Iterable<El>;
  closest(s: string): El | null;
  contains(o: unknown): boolean;
  getBoundingClientRect(): unknown;
  addEventListener(
    t: 'click',
    f: (e: { target: unknown; preventDefault(): void }) => unknown,
  ): void;
}
interface Worker_ {
  state: string;
  addEventListener(t: 'statechange', f: () => void): void;
}
interface Reg {
  installing: Worker_ | null;
  waiting: Worker_ | null;
  active: Worker_ | null;
  scope: string;
  unregister(): Promise<boolean>;
}
interface Policy {
  createScriptURL(u: string): string;
}
const g = globalThis as unknown as {
  location: { origin: string; href: string };
  navigator: {
    serviceWorker?: {
      register(url: string, o: { scope: string }): Promise<Reg>;
      getRegistration(scope: string): Promise<Reg | undefined>;
      getRegistrations(): Promise<Reg[]>;
    };
  };
  trustedTypes?: { createPolicy(n: string, r: Policy): Policy };
  document: El;
  caches?: {
    open(n: string): Promise<{ put(k: string, r: Response): Promise<void> }>;
    has(n: string): Promise<boolean>;
    delete(n: string): Promise<boolean>;
    keys(): Promise<string[]>;
  };
  matchMedia(q: string): { matches: boolean };
};
const cache = () => g.caches as NonNullable<typeof g.caches>;
const sw = () => g.navigator.serviceWorker as NonNullable<typeof g.navigator.serviceWorker>;

const TOKEN = /^\/p\/([A-Za-z0-9_-]{16,128})\/barcode$/;
const KEY = () => `${g.location.origin}/p/saved`;
const EXPIRES_HEADER = 'x-pass-expires-at';

const can = () => !!g.navigator.serviceWorker && !!g.caches && !!crypto.subtle;

async function hashOf(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
const nameOf = async (path: string) => `barcode:${await hashOf(path.split('/')[2] ?? '')}`;

function pathOf(href: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, g.location.href);
    return u.origin === g.location.origin && TOKEN.test(u.pathname) ? u.pathname : null;
  } catch {
    return null;
  }
}

let policy: Policy | undefined;
/** A TrustedScriptURL for the worker where Trusted Types is enforced; admits only /p/sw.js. */
function swUrl(): string {
  const types = g.trustedTypes;
  if (!types) return PASS_SW_PATH;
  policy ??= types.createPolicy(SAVE_POLICY, {
    createScriptURL: (u) => {
      if (u !== PASS_SW_PATH) throw new TypeError('Unexpected script address.');
      return u;
    },
  });
  return policy.createScriptURL(PASS_SW_PATH);
}

async function clear(path: string): Promise<void> {
  await cache().delete(await nameOf(path));
  const reg = await sw().getRegistration(path);
  if (reg) await reg.unregister();
}

async function keep(name: string, res: Response): Promise<void> {
  const text = await res.text();
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('x-saved-at', String(Date.now()));
  headers.set('x-expires-at', res.headers.get(EXPIRES_HEADER) || '0');
  await (await cache().open(name)).put(KEY(), new Response(text, { status: 200, headers }));
}

async function save(path: string): Promise<void> {
  try {
    // Not serviceWorker.ready: it waits on the worker for this page's URL, which is out of scope.
    const reg = await sw().register(swUrl(), { scope: path });
    const worker = reg.installing || reg.waiting || reg.active;
    if (worker && worker.state !== 'activated') {
      const w = worker;
      await new Promise<void>((resolve, reject) => {
        w.addEventListener('statechange', () => {
          if (w.state === 'activated') resolve();
          else if (w.state === 'redundant') reject(new Error('worker'));
        });
      });
    }
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok || res.redirected) throw new Error('save');
    await keep(await nameOf(path), res);
  } catch (e) {
    await clear(path);
    throw e;
  }
}

function replay(host: El): void {
  const buddy = host.querySelector('[data-when="saved"] [data-scene="tuck"]');
  if (!buddy || g.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  buddy.removeAttribute('data-run');
  buddy.getBoundingClientRect();
  buddy.setAttribute('data-run', '');
}

function sheet(host: El, open: boolean): void {
  const dlg = host.querySelector('[data-save-sheet]');
  if (!dlg) return;
  if (!open) dlg.close?.();
  else dlg.showModal?.();
}

/** Wires every `[data-save-phone]` host under root, once; the host's data-save drives the CSS. */
export function mount(root: El = g.document): void {
  for (const host of root.querySelectorAll('[data-save-phone]:not([data-save-ready])')) {
    const path = pathOf(host.getAttribute('data-save-phone'));
    if (!path || !can()) continue;
    host.setAttribute('data-save-ready', '');
    nameOf(path)
      .then((name) => cache().has(name))
      .then(
        (on) => {
          if (on) host.setAttribute('data-save', 'saved');
        },
        () => undefined,
      );
    host.addEventListener('click', async (e) => {
      const el = e.target as El | null;
      const act = el?.closest?.('[data-save-do],[data-save-drop],[data-save-done]');
      if (!act || !host.contains(act)) return;
      e.preventDefault();
      if (act.hasAttribute('data-save-done')) return sheet(host, false);
      if (host.getAttribute('data-save') === 'busy') return;
      if (act.hasAttribute('data-save-drop')) {
        await clear(path);
        host.removeAttribute('data-save');
        return;
      }
      host.setAttribute('data-save', 'busy');
      try {
        await save(path);
        host.setAttribute('data-save', 'saved');
        replay(host);
        sheet(host, true);
      } catch {
        // save() cleared whatever it wrote; the failed state says so.
        host.setAttribute('data-save', 'failed');
      }
    });
  }
  for (const host of root.querySelectorAll('[data-save-ended]')) {
    const path = pathOf(host.getAttribute('data-save-ended'));
    if (path && can()) clear(path).catch(() => undefined);
  }
}

/** Sign-out: every saved copy and every door worker, whatever the pass. */
export async function clearAll(): Promise<void> {
  if (!can()) return;
  for (const name of await cache().keys())
    if (name.startsWith('barcode:')) await cache().delete(name);
  for (const reg of await sw().getRegistrations()) {
    if (TOKEN.test(new URL(reg.scope).pathname)) await reg.unregister();
  }
}
