/** Lines a pass holder reads on the sign-in page, the pass pages and the pass email. */
export const HOLDER_COPY = {
  /** Under the sign-in card. */
  signInFooter: 'Your passes are tied to your email.',
  /** The pass email's title (and its preview in the console). */
  passReady: 'Your pass is ready',
  /** Where this device cannot add to Apple Wallet. */
  openOnApple: 'Open this page on your phone to add the pass to your wallet.',
  /** In an in-app web view, which cannot add to Wallet. */
  openInSafari: 'Open in Safari to add to Apple Wallet.',
  qrAlt: (pass: string) => `QR code for ${pass}`,
  /** The pass page's add block and My passes' QR dialog: the name, then the ways beside the QR. */
  addTitle: 'Add to Apple Wallet',
  iphone: 'On your iPhone',
  scanLine: 'Scan with the camera.',
  /** An Apple device registered the pass. */
  added: 'In Apple Wallet',
  addedLine: 'If it is missing, add it again.',
  inWalletPill: 'In Wallet',
  showQr: 'Show QR',
  hideQr: 'Hide QR',
  addHere: 'Add to this iPhone',
  hide: 'Hide',
  qrFailed: 'Could not draw the QR code. Reload.',
  voided: 'This pass was voided. It no longer works.',
  /** Under one voided pass in a bundle. */
  voidedShort: 'No longer valid.',
  voidedMany: 'These passes were voided. They no longer work.',
  expired: 'This pass has expired.',
  /** The org took the pass out of Wallet; its own note follows. */
  removedPlain: 'This pass was removed.',
  removed: 'Removed from Wallet. It stays in Expired passes until you delete it.',
  /** A voided pass whose org has no contact of its own: name the org, never the platform. */
  askForNew: (org: string) => `Ask ${org || 'the organization'} for a new pass.`,
  /** After the voided line: the org's support, email first. */
  contact: (org: string) => `Contact ${org}`,
  /** The org's support contacts under the add block. */
  help: 'Help',
  /** /p: the holder's own page in the portal (Refresh, Remove), through sign-in. */
  openInPortal: 'Open in My passes',
  /** The wallet choice: the way that fits this device, then the rest. */
  bestForDevice: 'Best for this device',
  otherWays: 'Other ways',
  browserTitle: 'Show a barcode in your browser',
  browserLine: 'For readers that scan a screen.',
  showBarcode: 'Show barcode',
  /** The barcode page: one line for the reader, then the offline copy (this device only). */
  presentLine: 'Show this to the reader.',
  presentUnavailable: 'Barcode unavailable',
  presentUnavailableLine: (org: string) => `Ask ${org || 'the organization'} for help.`,
  backToPass: 'Back to pass',
  saveOffline: 'Save for offline',
  savedOffline: 'Saved on this device',
  removeSaved: 'Remove from this device',
  saveOfflineLine: 'Works without signal. Staff still verify it.',
  connectToRefresh: 'Connect to refresh this pass.',
  saveOfflineFailed: 'Could not save. Try again.',
  /** The pass email, under the Apple badge: it reads the same on any phone. */
  emailAddLine: 'Open this email on your phone to add the pass to your wallet.',
  /** The bundle email's, for several passes. */
  emailAddLines: 'Open this email on your phone to add the passes to your wallet.',
  /** The pass page's link preview when native wallets are offered too. */
  previewWallets: 'Add it to your wallet.',
  /** Mail the pass again: the pass page, My passes and the sign-in code. */
  sendAgain: 'Send it again',
  /** The same, on the pass page: it says what is sent. */
  emailPassAgain: 'Email me this pass again',
  sendAgainSent: 'Sent. Check your email.',
  sendAgainWait: 'Sent a few already. Try again in an hour.',
  /** My passes: new code and link; old copies stop at the door. */
  lostPhone: 'I lost my phone',
  lostPhoneDone:
    'Done. The old copies stop working and your other devices are signed out. Check your email for the new pass.',
  /** A voided or expired pass: when, then who to ask. */
  voidedOn: (date: string) => `This pass was voided on ${date}. It no longer works.`,
  expiredOn: (date: string) => `This pass expired on ${date}.`,
  /** My passes: the group of voided and removed ones, under the live ones. */
  endedTitle: 'Voided and removed',
  /** My passes. */
  noPasses: 'Passes sent to your verified emails show up here.',
  addAllTitle: 'Add all to Apple Wallet',
  addAllOne: 'Add to Apple Wallet',
  addAllCount: (n: number) => `Add ${n} passes`,
  removalPending: (n: number) => (n === 1 ? 'Removing 1 pass.' : `Removing ${n} passes.`),
  removalPendingLine: 'Each leaves this list once your wallets let go of it.',
  removalStarted: 'Removal started. It finishes once your wallets let go of the pass.',
  /** A pass that cannot be opened until the org issues a new one. */
  reissueTitle: 'Passes that need a new copy',
  reissueLine: (pass: string, org: string) => `${pass} from ${org} needs a new copy.`,
  reissueAsk: (org: string) => `Ask ${org || 'the organization'} to send one.`,
  /** The strip on a test pass or bundle, on its page and in its email. */
  testNote: (what: 'pass' | 'bundle') => `Test ${what}. It is not real and will be deleted.`,
  /** "3 passes": a bundle's size, on its page and in its email. */
  count: (n: number) => `${n} ${n === 1 ? 'pass' : 'passes'}`,
  /** /p link previews. */
  previewActive: 'Open your pass.',
  previewVoided: 'This pass was voided.',
  previewRemoved: 'This pass was removed from Wallet.',
  /**
   * An unknown, rotated or expired /p or /b link. The server cannot say which (that would tell a
   * guesser a token once existed), so the words name the thing and what to do. Its way on is My
   * passes (STATE_COPY.goToMyPasses).
   */
  deadLinkTitle: (what: 'pass' | 'bundle') => `This ${what} link does not work`,
  deadLinkLine: 'It may have been replaced. Ask the organization for a new one.',
} as const;
