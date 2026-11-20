/** Scanner words for bundle check-in. `{n}` and `{total}` mark values. */
export const SCAN_GROUP_COPY = {
  checkInAll: 'Check in all {total}',
  inCount: '{n} of {total} in',
  summary: '{done} in',
  already: '{n} already in',
  refused: '{n} not let in',
  state: { done: 'In', already: 'Already in', refused: 'Not let in' },
} as const;

export const groupLine = (g: { done: number; already: number; refused: number }): string =>
  [
    SCAN_GROUP_COPY.summary.replace('{done}', String(g.done)),
    g.already ? SCAN_GROUP_COPY.already.replace('{n}', String(g.already)) : null,
    g.refused ? SCAN_GROUP_COPY.refused.replace('{n}', String(g.refused)) : null,
  ]
    .filter(Boolean)
    .join(' · ');
