import { importErrorMessage } from '@/shared/contracts/templates.ts';

const KIND_LABELS: Record<string, string> = {
  template_import: 'Template import',
  bulk_reissue: 'Bulk reissue',
  connection_sync: 'Connection sync',
  broadcast: 'Message',
};

const RUN_ERRORS: Record<string, string> = {
  BULK_REISSUE_FAILED: 'The reissue failed. Run it again.',
  PARTIAL_FAILURE: 'Some passes failed. Check them and retry.',
};

export function workflowKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** One sentence for a workflow error code. */
export function workflowErrorMessage(kind: string, code: string): string {
  const known = RUN_ERRORS[code];
  if (known) return known;
  if (kind === 'template_import') return importErrorMessage(code) ?? 'The run failed. Try again.';
  return 'The run failed. Try again.';
}
