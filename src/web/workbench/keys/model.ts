import type { DeveloperHomeKey } from '../../../shared/contracts/developer-home.ts';
import { BENCH_KEYS_COPY as C } from '../../../shared/copy/developers-bench-keys.ts';
import { presetOf } from '../../../shared/developers-keys.ts';
import type { StatusTone } from '../bench/status-chip.tsx';
import { type keyState, masked } from '../home/model.ts';

/** The preset the key's scopes equal, else how many scopes it holds. */
export const accessOf = (k: Pick<DeveloperHomeKey, 'scopes'>): string =>
  presetOf(k.scopes) ?? C.facts.scopes(k.scopes.length);

/** What the page draws of a secret once it hides it: its start and last four, never the middle. */
export const maskSecret = (secret: string): string =>
  `${secret.slice(0, secret.indexOf('_', 5) + 1 || 9)}…${secret.slice(-4)}`;

export type KeyState = ReturnType<typeof keyState>;
export const STATE_TONE: Record<KeyState, StatusTone> = {
  active: 'success',
  rolling: 'neutral',
  expired: 'neutral',
};

/** A key as a person searches it: its name and the start of its secret. */
export const matches = (k: DeveloperHomeKey, q: string): boolean =>
  `${k.name} ${masked(k)}`.toLowerCase().includes(q.trim().toLowerCase());
