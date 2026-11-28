import { TURNSTILE_SANDBOX_ACTION } from '../../../shared/turnstile.ts';
import { loadTurnstile, TURNSTILE_BASE_OPTIONS } from '../../lib/turnstile-script.ts';

/** Runs the sandbox check. `shown` tells the page to make room when the widget needs the person. */
export async function verify(
  host: HTMLElement,
  siteKey: string,
  shown: (on: boolean) => void,
): Promise<string> {
  const api = await loadTurnstile();
  return new Promise((resolve, reject) => {
    const id = api.render(host, {
      sitekey: siteKey,
      action: TURNSTILE_SANDBOX_ACTION,
      ...TURNSTILE_BASE_OPTIONS,
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
