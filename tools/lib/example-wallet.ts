// While Google or Samsung is not released, no example may show what only a released provider does: an offer to
// save, an instance, an operation, a provider's report, issuance, or the channel on. Pure; the test supplies the
// release state from wallet-providers/provider-policy.ts, the one place that decides it.
type Json = Record<string, unknown>;
export type WalletProvider = 'google' | 'samsung';

interface Example {
  where: string;
  value: unknown;
}

const PROVIDERS: readonly WalletProvider[] = ['google', 'samsung'];
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** One message per thing an example shows a dark provider doing. */
export function darkWalletFailures(
  examples: Example[],
  released: (provider: WalletProvider) => boolean,
): string[] {
  const dark = new Set(PROVIDERS.filter((p) => !released(p)));
  const out: string[] = [];
  for (const ex of examples) {
    const bad = (at: string, why: string) => out.push(`${ex.where}${at}: ${why}`);
    const visit = (v: unknown, at: string): void => {
      if (Array.isArray(v)) {
        for (const [i, x] of v.entries()) visit(x, `${at}[${i}]`);
        return;
      }
      if (!isObj(v)) return;
      const p =
        typeof v.provider === 'string' && dark.has(v.provider as WalletProvider)
          ? v.provider
          : null;
      if (p && 'href' in v) bad(at, `offers a ${p} save while ${p} is not released`);
      if (p && typeof v.lifecycle === 'string' && v.lifecycle !== 'absent')
        bad(`${at}.lifecycle`, `a ${p} instance is ${v.lifecycle} while ${p} is not released`);
      if (p && v.desiredOperation)
        bad(`${at}.desiredOperation`, `a ${p} operation while ${p} is not released`);
      if (p && v.reported) bad(`${at}.reported`, `a ${p} report while ${p} is not released`);
      if (p && isObj(v.issuance) && v.issuance.state === 'enabled')
        bad(`${at}.issuance`, `${p} issues while it is not released`);
      for (const d of dark) {
        const own = v[d];
        if (isObj(own) && own.on === true)
          bad(`${at}.${d}`, `the ${d} channel is on while ${d} is not released`);
        if (isObj(own) && own.state === 'enabled' && /walletIssuance$/.test(at))
          bad(`${at}.${d}`, `${d} issues while it is not released`);
      }
      for (const [k, x] of Object.entries(v)) visit(x, `${at}.${k}`);
    };
    visit(ex.value, '');
  }
  return out;
}
