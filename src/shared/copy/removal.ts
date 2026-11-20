/** What Remove from Wallet does in each wallet. None can delete a pass from a device. */
export type RemovalWallet = 'apple' | 'google' | 'samsung';

export const REMOVAL_EFFECT: Record<RemovalWallet, string> = {
  apple: 'Apple Wallet moves it to Expired passes once the update arrives.',
  google: 'Google Wallet marks it expired; the holder deletes it there.',
  samsung: 'Samsung Wallet gets a delete request; the card goes if the holder is online.',
};

export const REMOVAL_WALLET_NAME: Record<RemovalWallet, string> = {
  apple: 'Apple Wallet',
  google: 'Google Wallet',
  samsung: 'Samsung Wallet',
};

/** One line per wallet the removal reaches, Apple first. */
export const removalEffects = (wallets: readonly RemovalWallet[]): string[] =>
  (['apple', 'google', 'samsung'] as const)
    .filter((w) => wallets.includes(w))
    .map((w) => REMOVAL_EFFECT[w]);
