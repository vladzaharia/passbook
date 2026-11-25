/** Words on the print page, the admin Print card and the designer's Paper tab. */
export const PRINT_COPY = {
  title: 'Print your ticket',
  staffTitle: 'Print ticket',
  lede: 'Print at actual size (100 %) on white paper.',
  print: 'Print',
  download: 'Download PDF',
  make: 'Make my ticket',
  reprint: 'Reprint',
  void: 'Void print',
  code: 'Ticket code',
  codeNote: 'Type this code if the barcode will not scan.',
  /** Page for a holder whose ticket cannot be printed. */
  unavailable: 'Printing unavailable',
  unavailableLine: (org: string) => `Ask ${org || 'the organization'} for a printed ticket.`,
  noPrint: 'No print yet.',
  noPrintStaff: 'No active print. Make one from the pass.',
  codeUnavailable: 'Barcode unavailable',
  confirmReprint: 'Reprint? The earlier print stops working.',
  confirmVoid: 'Void this print? Its code stops working.',
  confirmYes: 'Yes',
  cancel: 'Cancel',
  failed: 'Could not do that. Try again.',
  limited: 'Too many changes. Try again later.',
  back: 'Back to pass',
  /** Admin card. */
  card: 'Printed ticket',
  cardEmpty: 'No printed ticket.',
  printed: (n: number) => `Print ${n}`,
  made: 'Ticket printed',
  reprinted: 'Ticket reprinted',
  voided: 'Print voided',
  couldNotPrint: 'Could not print',
  couldNotVoid: 'Could not void',
  voidConfirmTitle: 'Void print?',
  voidConfirmBody: 'Its code stops working at the door. You can print again.',
  reprintConfirmTitle: 'Reprint ticket?',
  reprintConfirmBody: 'The earlier print stops working at the door.',
  /** Bulk Print on the passes list. */
  bulkNone: 'Nothing to print. Printing is off for these passes.',
  bulkPreparing: (tickets: string, skipped: number, why = '') =>
    skipped > 0
      ? `Preparing ${tickets}. ${skipped} skipped${why ? `: ${why}` : ''}.`
      : `Preparing ${tickets}.`,
  bulkReady: (tickets: string, lossy: boolean, skipped = 0, why = '') =>
    `${tickets} ready${skipped > 0 ? `, ${skipped} skipped${why ? `: ${why}` : ''}` : ''}${lossy ? '. Some names could not be shown.' : ''}`,
  lossy: 'Some characters cannot be printed and will show as plain letters or ?.',
  bulkDownload: 'Download',
  bulkFailed: 'The PDF could not be made. Try again.',
  bulkSlow: 'The PDF is taking long. Try again shortly.',
  bulkCap: (n: number) => `Up to ${n} passes.`,
  /** Designer tab. */
  tab: 'Paper',
  sizeLabel: 'Paper size',
  sample: 'Sample',
  derived: 'Layout from the ticket fields.',
  staffOnly: 'Staff print only.',
  editLayout: 'Edit layout',
  kindLabel: 'Layout',
  kindAuto: 'Auto',
  kinds: {
    admission: 'Admission',
    membership: 'Membership',
    permit: 'Permit',
    coupon: 'Coupon',
    pickup: 'Pickup',
  },
  inkLabel: 'Ink',
  inkColour: 'Colour',
  inkMono: 'Mono',
  inkMonoNote: 'Printed mono: the pass colours are too light for black and white.',
  buddyLabel: 'PassBook buddy',
  foldLabel: 'Fold marks',
  bringLabel: 'Bring',
  bringHelp: 'Extra lines, separated by semicolons.',
  greyscale: 'Greyscale preview',
  useDerived: 'Use derived layout',
} as const;

/** What a printed ticket says besides the facts. `oneTicket` says the print and the phone are one; `once` comes from the check-in rule. */
export const PAPER_COPY = {
  before: 'Before you go',
  beforePickup: 'Your order',
  oneTicket: (noun: string, once: boolean) => [
    `One ${noun}`,
    `This print and your phone ${noun} are the same ${noun}. ${once ? 'Either one gets you in once.' : 'Use either one.'}`,
  ],
  reprints: ['Reprints', 'A reprint cancels this copy. Only the newest print works.'],
  atDoor: ['At the door', 'Keep the code flat and unmarked. Staff can type the ticket code.'],
  folding: ['Folding', 'Fold on the marks, in half and in half again. The code stays outside.'],
  bringDefault: (noun: string) => `This page or your phone ${noun}`,
  bringId: (name: string) => `Photo ID in the name ${name}`,
  zoneNote: (abbr: string, name?: string) =>
    name ? `Times are ${name} (${abbr}).` : `Times are in ${abbr}.`,
  issued: (n: number, when: string) => `Print ${n} · Issued ${when}`,
  testStrip: 'TEST TICKET · NOT VALID FOR ENTRY',
  testMark: 'TEST · NOT VALID',
  permitHow: 'Place face up on the dashboard, readable through the windscreen.',
  fold: 'Fold',
  codeLabel: {
    admission: 'Ticket code',
    day: 'Pass code',
    membership: 'Card code',
    permit: 'Permit code',
    coupon: 'Coupon code',
    pickup: 'Slip code',
  },
} as const;

/** The print code in groups, easier to read and to type. */
export function groupPrintCode(code: string): string {
  return code.match(/.{1,9}/g)?.join(' ') ?? code;
}
