import { TURNSTILE_SANDBOX_ACTION } from '../../../shared/turnstile.ts';

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type Api = NonNullable<Window['turnstile']>;

let loading: Promise<Api> | undefined;

/** The portal's CSP requires Trusted Types for script URLs: one policy that admits this one address. */
function scriptUrl(): string {
  const types = (
    window as unknown as {
      trustedTypes?: { createPolicy(n: string, r: object): { createScriptURL(s: string): string } };
    }
  ).trustedTypes;
  if (!types) return SRC;
  const policy = types.createPolicy('passbook-turnstile', {
    createScriptURL: (u: string) => {
      if (u !== SRC) throw new TypeError('Unexpected script address.');
      return u;
    },
  });
  return policy.createScriptURL(SRC);
}

function load(): Promise<Api> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = scriptUrl();
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('missing')));
    s.onerror = () => {
      loading = undefined;
      reject(new Error('blocked'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Runs the sandbox check. `shown` tells the page to make room when the widget needs the person. */
export async function verify(
  host: HTMLElement,
  siteKey: string,
  shown: (on: boolean) => void,
): Promise<string> {
  const api = await load();
  return new Promise((resolve, reject) => {
    const id = api.render(host, {
      sitekey: siteKey,
      action: TURNSTILE_SANDBOX_ACTION,
      appearance: 'interaction-only',
      'before-interactive-callback': () => shown(true),
      'after-interactive-callback': () => shown(false),
      callback: (token: string) => {
        resolve(token);
        setTimeout(() => api.remove(id), 0);
      },
      'error-callback': () => reject(new Error('check')),
      'expired-callback': () => reject(new Error('expired')),
    });
  });
}
