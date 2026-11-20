/** What the chip over a repeated code says. */
export const chipText = (chip: 'just_now' | 'already_open' | { same: string }) =>
  typeof chip === 'object' ? chip.same : chip === 'already_open' ? 'Already open' : 'Just scanned';
