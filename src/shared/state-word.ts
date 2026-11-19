/** The word a holder's pages and cards use for a pass the record says is ended; none while live. */
export function stateWordOf(pass: {
  removedAt: number | null;
  status: string;
}): 'Removed' | 'Voided' | undefined {
  return pass.removedAt !== null ? 'Removed' : pass.status === 'voided' ? 'Voided' : undefined;
}

/** For normalize's options: `{ stateWord }` once the record says the pass ended, else nothing. */
export function stateWordOption(pass: {
  removedAt: number | null;
  status: string;
}): { stateWord: string } | Record<string, never> {
  const stateWord = stateWordOf(pass);
  return stateWord ? { stateWord } : {};
}
