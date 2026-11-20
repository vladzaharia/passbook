import type { SamsungWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import { sha256Hex } from '../../platform/ids.ts';

/** The default card's card-map key; types without their own card use it. */
export const DEFAULT_CARD_TYPE = 'generic';

type CardCredentials = Pick<SamsungWalletCredentials, 'cardId' | 'cardIds'>;

/** The card for one pass type: its own entry, else the default card. Never another type's card. */
export function samsungCardId(credentials: CardCredentials, cardType: string): string {
  return credentials.cardIds?.[cardType] ?? credentials.cardId;
}

/** Every type the credential names, the default included, with its card id. */
export function samsungCardEntries(credentials: CardCredentials): [string, string][] {
  return [[DEFAULT_CARD_TYPE, credentials.cardId], ...Object.entries(credentials.cardIds ?? {})];
}

/** The version's card map: type to sha256(cardId). */
export async function samsungCardMap(
  credentials: CardCredentials,
): Promise<Record<string, string>> {
  if (credentials.cardIds && Object.hasOwn(credentials.cardIds, DEFAULT_CARD_TYPE))
    throw new Error('The default card type cannot be a per-type card.');
  const entries = await Promise.all(
    samsungCardEntries(credentials).map(async ([type, id]) => [type, await sha256Hex(id)] as const),
  );
  return Object.fromEntries(entries);
}
