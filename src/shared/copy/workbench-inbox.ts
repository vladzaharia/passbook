/** Words for the Workbench's Inbox and Activity tools. The empty lines live in `workbench-states.ts`. */
export const WB_INBOX = {
  list: 'Test emails',
  select: 'Select an email',
  failed: 'Failed',
  count: (n: number, more: boolean) => `${n}${more ? '+' : ''} ${n === 1 ? 'email' : 'emails'}`,
  forPass: 'A pass',
  forBundle: 'A bundle',
} as const;

export const WB_ACTIVITY = {
  list: 'Operations',
  select: 'Select an operation',
  earlier: 'Earlier',
  running: 'Running',
  count: (n: number) => `${n} ${n === 1 ? 'operation' : 'operations'}`,
} as const;
