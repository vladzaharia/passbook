/**
 * Radix's popper wrapper sits in the body outside every landmark; naming it a region keeps the
 * popup inside one (axe `region`).
 */
export function nameWrapper(node: HTMLElement | null, label: string) {
  const wrapper = node?.parentElement;
  if (!wrapper?.hasAttribute('data-radix-popper-content-wrapper')) return;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', label);
}
