/** Words on the print page, the admin Print card and the designer's Paper tab. */
export const PRINT_COPY = {
  title: 'Print your ticket',
  staffTitle: 'Print ticket',
  lede: 'Print at actual size on white paper.',
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
  bulkPreparing: (tickets: string, skipped: number) =>
    skipped > 0 ? `Preparing ${tickets}. ${skipped} skipped.` : `Preparing ${tickets}.`,
  bulkReady: (tickets: string, lossy: boolean, skipped = 0) =>
    `${tickets} ready${skipped > 0 ? `, ${skipped} skipped` : ''}${lossy ? '. Some names could not be shown.' : ''}`,
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
  useDerived: 'Use derived layout',
} as const;

/** The print code in groups, easier to read and to type. */
export function groupPrintCode(code: string): string {
  return code.match(/.{1,9}/g)?.join(' ') ?? code;
}
