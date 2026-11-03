/** Lines a pass holder reads on the sign-in page, the pass pages and the pass email. */
export const HOLDER_COPY = {
  /** Under the sign-in card. */
  signInFooter: 'Signing in shows the passes sent to your email.',
  /** Where this device cannot add to Wallet. */
  openOnApple: 'Open on iPhone or Mac to add to Apple Wallet.',
  /** In an in-app web view, which cannot add to Wallet. */
  openInSafari: 'Open in Safari to add to Apple Wallet.',
  /** Beside the add QR. */
  scanQr: 'Scan with your iPhone.',
  qrAlt: (pass: string) => `QR code for ${pass}`,
  qrFailed: 'Could not draw the QR code. Reload.',
  voided: 'This pass was voided.',
  expired: 'This pass has expired.',
  /** After the voided line: the org's support, email first. */
  contact: (org: string) => `Contact ${org}`,
  /** The org's support contacts under the add block. */
  help: 'Help',
  /** /p: the holder's own page in the portal (Refresh, Remove), through sign-in. */
  openInPortal: 'Open in My passes',
  /** /p link previews. */
  previewActive: 'Add it to Apple Wallet.',
  /** An unknown, rotated or expired /p link; its way on is My passes (STATE_COPY.goToMyPasses). */
  deadLinkTitle: 'Link expired',
  deadLinkLine: 'Sign in to see your passes.',
} as const;
