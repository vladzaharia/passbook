/** A platform hold turns an organization's wallet account Off until it is released. Dangerous tone. */
export function holdConfirm(name: string) {
  return {
    title: `Hold ${name}?`,
    confirmLabel: 'Hold',
    description: 'Turns it Off. The organization cannot turn it on until you release it.',
    typed: false,
  };
}
