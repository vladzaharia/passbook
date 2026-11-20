const RESET_MS = 1500;

/** The text a copy button stands for: the visible sample, the response, the path or the command. */
function textFor(button: HTMLElement): string {
  // A button that carries its own text (a command built from a capture).
  if (button.dataset.copyText !== undefined) return button.dataset.copyText;
  const owner = button.closest<HTMLElement>('[data-samples], .resp, .endpoint, .cmd, .code');
  if (!owner) return '';
  if (owner.matches('.endpoint')) return owner.querySelector('code')?.textContent ?? '';
  if (owner.matches('.cmd')) return owner.querySelector('code')?.textContent ?? '';
  const panels = [...owner.querySelectorAll<HTMLElement>('[data-panel]')];
  const shown = panels.find((p) => getComputedStyle(p).display !== 'none');
  const region = shown ?? owner;
  // Lines are blocks, so their text has no newlines of its own.
  const lines = [...region.querySelectorAll('.ln')];
  return lines.length > 0 ? lines.map((l) => l.textContent).join('\n') : (region.textContent ?? '');
}

// Not the kit's copyText: that toasts through sonner and React, which the portal's first load cannot afford.
export function initCopy(): void {
  document.addEventListener('click', async (event) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-copy]');
    if (!button) return;
    const label = button.getAttribute('aria-label') ?? 'Copy';
    try {
      await navigator.clipboard.writeText(textFor(button));
      button.dataset.state = 'copied';
      button.setAttribute('aria-label', 'Copied');
    } catch {
      button.dataset.state = 'failed';
      button.setAttribute('aria-label', 'Could not copy. Allow clipboard access and try again.');
    }
    setTimeout(() => {
      delete button.dataset.state;
      button.setAttribute('aria-label', label);
    }, RESET_MS);
  });
}
