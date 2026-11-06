/** Boot and Start strings that `SCAN_COPY` does not carry (SD 5.1). Everything else reads SCAN_COPY. */
export const UI_COPY = {
  scanPairingCode: 'Scan pairing code',
  confirmTitle: 'Pair this device?',
  confirmLine: 'As {scanner} for {org}.',
  paired: 'Paired as {scanner}.',
  scanAsAdmin: 'Scan as admin',
  organization: 'Organization',
  event: 'Event',
  templates: 'Templates',
  continue: 'Continue',
  switchToTest: 'Switch to Test',
  switchToLive: 'Switch to Live',
  direction: 'Direction',
  dirIn: 'In',
  dirOut: 'Out',
  opens: 'Scanning opens {time}.',
  closed: 'Scanning closed {time}.',
  signIn: 'Sign in',
  starting: 'Starting camera…',
} as const;

export const fill = (text: string, values: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
