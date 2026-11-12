/** A passless refusal, identified by its `scans` row. Nothing else is stored or verified. */
export interface PasslessScan {
  readonly scanId: string;
  readonly orgId: string;
  readonly mode: 'live' | 'test';
  readonly at: number;
}
