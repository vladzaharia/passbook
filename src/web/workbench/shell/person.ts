/**
 * Whose browser storage the shell reads: the single-key switch and the seen marks are kept per
 * person, so two people on one browser never share them. The layout names the person before its
 * children render (the space remounts for each person).
 */
let person = 'anon';

export function setPerson(userId: string | undefined): void {
  person = userId ?? 'anon';
}

export const personKey = (base: string): string => `${base}:${person}`;
