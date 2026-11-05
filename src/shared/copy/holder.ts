/** Lines a pass holder reads on the sign-in page, the pass pages and the pass email. */
export const HOLDER_COPY = {
  /** Under the sign-in card. */
  signInFooter: 'Signing in shows the passes sent to your email.',
  /** The pass email's title (and its preview in the console). */
  passReady: 'Your pass is ready',
  /** Where this device cannot add to Wallet. */
  openOnApple: 'Open on iPhone or Mac to add to Apple Wallet.',
  /** In an in-app web view, which cannot add to Wallet. */
  openInSafari: 'Open in Safari to add to Apple Wallet.',
  qrAlt: (pass: string) => `QR code for ${pass}`,
  /** The pass page's add block and My passes' QR dialog: the name, then the ways beside the QR. */
  addTitle: 'Add to Apple Wallet',
  iphone: 'On your iPhone',
  scanLine: 'Scan with the camera.',
  mac: 'On this Mac',
  /** On a device already: the add block's quiet line and its way to add again. */
  added: 'In Apple Wallet',
  addedLine: 'Updates arrive on their own.',
  showQr: 'Show QR',
  hideQr: 'Hide QR',
  addHere: 'Add to this iPhone',
  hide: 'Hide',
  qrFailed: 'Could not draw the QR code. Reload.',
  voided: 'This pass was voided.',
  voidedMany: 'These passes were voided.',
  expired: 'This pass has expired.',
  /** The org took the pass out of Wallet; its own note follows. */
  removed: 'Removed from Wallet. It stays in Expired passes until you delete it.',
  /** A voided pass whose org has no contact of its own: name the org, never the platform. */
  askForNew: (org: string) => `Ask ${org || 'the organization'} for a new pass.`,
  /** After the voided line: the org's support, email first. */
  contact: (org: string) => `Contact ${org}`,
  /** The org's support contacts under the add block. */
  help: 'Help',
  /** /p: the holder's own page in the portal (Refresh, Remove), through sign-in. */
  openInPortal: 'Open in My passes',
  /** The strip on a test pass or bundle, on its page and in its email. */
  testNote: (what: 'pass' | 'bundle') => `Test ${what}. It is not real and will be deleted.`,
  /** "3 passes": a bundle's size, on its page and in its email. */
  count: (n: number) => `${n} ${n === 1 ? 'pass' : 'passes'}`,
  /** /p link previews. */
  previewActive: 'Add it to Apple Wallet.',
  previewRemoved: 'This pass was removed from Wallet.',
  /** An unknown, rotated or expired /p link; its way on is My passes (STATE_COPY.goToMyPasses). */
  deadLinkTitle: 'Link expired',
  deadLinkLine: 'Sign in to see your passes.',
} as const;
