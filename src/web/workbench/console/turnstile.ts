import { TURNSTILE_SANDBOX_ACTION } from '../../../shared/turnstile.ts';
import { turnstileScriptUrl } from '../../lib/turnstile-script.ts';

type Api = NonNullable<Window['turnstile']>;

let loading: Promise<Api> | undefined;

function load(): Promise<Api> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = turnstileScriptUrl();
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
