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

/** One sample's lines, from a panel that may be hidden. */
const panelText = (panel: Element): string =>
  [...panel.querySelectorAll('.ln')].map((l) => l.textContent).join('\n');

/** The sample for a "Copy as" button: its language's, or the open one fenced as Markdown. */
function sampleFor(button: HTMLElement): string {
  const owner = button.closest<HTMLElement>('[data-samples]');
  const lang = button.dataset.copyAs;
  if (!owner || !lang) return '';
  if (lang !== 'md') {
    const panel = owner.querySelector(`[data-panel="${lang}"]`);
    return panel ? panelText(panel) : '';
  }
  const shown = owner.querySelector<HTMLInputElement>('input[data-lang]:checked');
  const panel = owner.querySelector(`[data-panel="${shown?.dataset.lang ?? ''}"]`);
  return panel ? `\`\`\`${shown?.dataset.lang}\n${panelText(panel)}\n\`\`\`` : '';
}

/** True when the text is on the clipboard. Islands use it too, so the one clipboard call lives here. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Not the kit's copyText: that toasts through sonner and React, which the portal's first load cannot afford.
export function initCopy(): void {
  document.addEventListener('click', async (event) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-copy], [data-copy-as]');
    if (!button) return;
    // An icon button is named by its label; a "Copy as" button by its text, which the state suffix extends.
    const label = button.getAttribute('aria-label');
    const text = button.dataset.copyAs ? sampleFor(button) : textFor(button);
    if (await copyToClipboard(text)) {
      button.dataset.state = 'copied';
      if (label) button.setAttribute('aria-label', 'Copied');
    } else {
      button.dataset.state = 'failed';
      if (label)
        button.setAttribute('aria-label', 'Could not copy. Allow clipboard access and try again.');
    }
    setTimeout(() => {
      delete button.dataset.state;
      if (label) button.setAttribute('aria-label', label);
    }, RESET_MS);
  });
}
