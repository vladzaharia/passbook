/** Words on the print page, the admin Print card and the designer's Paper tab. */
export const PRINT_COPY = {
  title: 'Print your ticket',
  staffTitle: 'Print ticket',
  lede: 'Print at actual size on white paper.',
  print: 'Print',
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
  /** Designer tab. */
  tab: 'Paper',
  sizeLabel: 'Paper size',
  sample: 'Sample',
  derived: 'Layout from the ticket fields.',
  staffOnly: 'Staff print only.',
} as const;

/** The print code in groups, easier to read and to type. */
export function groupPrintCode(code: string): string {
  return code.match(/.{1,9}/g)?.join(' ') ?? code;
}
