type Policy = { createScriptURL(s: string): string };

/** The scanner's CSP requires Trusted Types for script URLs: one policy that admits same-origin addresses only. */
let policy: Policy | undefined;

/** The address of a same-origin worker script, in the form `new Worker` and `serviceWorker.register` accept. */
export function trustedWorkerUrl(url: string | URL): string {
  const types = (
    window as unknown as { trustedTypes?: { createPolicy(n: string, r: object): Policy } }
  ).trustedTypes;
  if (!types) return String(url);
  policy ??= types.createPolicy('passbook-worker', {
    createScriptURL: (u: string) => {
      const parsed = new URL(u, location.href);
      if (parsed.origin !== location.origin) throw new TypeError('Unexpected script address.');
      return parsed.href;
    },
  });
  return policy.createScriptURL(String(url));
}
