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
