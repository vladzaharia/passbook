import { SIGN_IN_METHOD, signInMethodLabel } from '@/web/lib/status.ts';

/** Identity providers as the auth module stores them. */
const PROVIDER_LABEL: Record<string, string> = {
  pocketid: SIGN_IN_METHOD.oidc,
  breakglass: SIGN_IN_METHOD.breakglass,
};

export const providerLabel = (provider: string) => PROVIDER_LABEL[provider] ?? provider;
export const isPolaris = (provider: string) => provider === 'pocketid';

/** "Polaris ID, Email link"; "—" when none. */
export const methodsLabel = (methods: readonly string[]) =>
  methods.length ? methods.map(signInMethodLabel).join(', ') : '—';
