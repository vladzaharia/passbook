import { defineOperationKind } from '../define.ts';

export const printsBulk = defineOperationKind({
  kind: 'prints.bulk',
  audience: 'org',
  // The PDF holds scan codes: only those who may operate passes see the job at all.
  read: 'passes:operate',
  write: 'passes:operate',
  cancel: 'never',
  retry: true,
  stepUp: false,
  stallMs: 10 * 60_000,
  title: 'Print tickets',
  doneTitle: 'Tickets ready',
  failTitle: 'Could not print tickets',
  errors: {
    PRINT_BULK_EMPTY: 'No ticket could be printed. Check the passes, then print again.',
    PRINT_BULK_VOIDED: 'A ticket was voided while printing. Print again.',
    PRINT_JOB_NOT_FOUND: 'The print job is gone. Print again.',
  },
  steps: [
    { key: 'pages', label: 'Prepare tickets', active: 'Preparing tickets', counts: true },
    { key: 'render', label: 'Draw the PDF', active: 'Drawing the PDF' },
    { key: 'save', label: 'Save the PDF', active: 'Saving the PDF' },
  ],
});
