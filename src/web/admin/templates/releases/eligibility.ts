/** Sole and Test approvals are the author's own, recorded and badged "Self-approved". */
export const selfApproved = (approval: { kind?: 'peer' | 'sole' | 'test' | undefined }) =>
  approval.kind === 'sole' || approval.kind === 'test';
