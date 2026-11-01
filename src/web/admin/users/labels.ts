import type { z } from 'zod';
import type { SignInMethodSchema } from '@/shared/contracts/users.ts';

type SignInMethod = z.infer<typeof SignInMethodSchema>;

export const AMR_LABEL: Record<SignInMethod, string> = {
  oidc: 'Polaris ID',
  magic_link: 'Email link',
  breakglass: 'Break-glass',
};

/** Identity providers as the auth module stores them. */
const PROVIDER_LABEL: Record<string, string> = {
  pocketid: 'Polaris ID',
  breakglass: 'Break-glass',
};

export const amrLabel = (amr: string) => AMR_LABEL[amr as SignInMethod] ?? amr;
export const providerLabel = (provider: string) => PROVIDER_LABEL[provider] ?? provider;
export const isPolaris = (provider: string) => provider === 'pocketid';

/** "Polaris ID, Email link"; "—" when none. */
export const methodsLabel = (methods: readonly string[]) =>
  methods.length ? methods.map(amrLabel).join(', ') : '—';
