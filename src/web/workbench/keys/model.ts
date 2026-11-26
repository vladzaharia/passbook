/** What the page draws of a secret once it hides it: its start and last four, never the middle. */
export const maskSecret = (secret: string): string =>
  `${secret.slice(0, secret.indexOf('_', 5) + 1 || 9)}…${secret.slice(-4)}`;
