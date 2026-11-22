export const IMPORT_STEPS = [
  { id: 'source', title: 'Source' },
  { id: 'match', title: 'Match' },
  { id: 'check', title: 'Check' },
  { id: 'issue', title: 'Issue' },
] as const;

export const STEP = { source: 0, match: 1, check: 2, issue: 3 } as const;
