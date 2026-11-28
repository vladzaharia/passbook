const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type Policy = { createScriptURL(s: string): string };

/** The pages' CSP requires Trusted Types for script URLs: one policy that admits this one address. */
let policy: Policy | undefined;

export function turnstileScriptUrl(): string {
  const types = (
    window as unknown as {
      trustedTypes?: { createPolicy(n: string, r: object): Policy };
    }
  ).trustedTypes;
  if (!types) return TURNSTILE_SCRIPT_SRC;
  policy ??= types.createPolicy('passbook-turnstile', {
    createScriptURL: (u: string) => {
      if (u !== TURNSTILE_SCRIPT_SRC) throw new TypeError('Unexpected script address.');
      return u;
    },
  });
  return policy.createScriptURL(TURNSTILE_SCRIPT_SRC);
}

export type TurnstileApi = {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
};

/** Options every widget shares: a check that cannot run stops; the next submit renders a fresh one. */
export const TURNSTILE_BASE_OPTIONS = { appearance: 'interaction-only', retry: 'never' } as const;

let scriptPromise: Promise<TurnstileApi> | undefined;

/** The one Turnstile script loader: sign-in, invite and the Workbench console all use it. */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = turnstileScriptUrl();
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing'));
    script.onerror = () => {
      scriptPromise = undefined;
      reject(new Error('turnstile blocked'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}
