/** An exit is recorded as a check-in action with direction out; every surface names it Check out. */
export function directedLabel(kind: string | null | undefined, label: string, direction: unknown) {
  return kind === 'check_in' && direction === 'out' ? 'Check out' : label;
}
