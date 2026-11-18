/** Moves focus to what the machine asks for, once the next frame has painted it. */
export function focusTarget(
  target: 'done' | 'region' | 'enter-code' | 'card-heading' | 'action',
): void {
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>(
        target === 'done'
          ? '[data-testid="dock-primary"]'
          : target === 'enter-code'
            ? '[data-scan-code]'
            : '#scan-result-heading',
      )
      ?.focus({ preventScroll: true }),
  );
}
