import { CODE_COPY } from '../../../shared/copy/developers-code.ts';

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

/** The page's one polite live region: "Copied", said once per copy whoever copied. */
export function announce(message: string): void {
  let region = document.getElementById('dev-live');
  if (!region) {
    region = document.createElement('div');
    region.id = 'dev-live';
    region.className = 'sr';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }
  const live = region;
  // Emptied first so the same words read again on the next copy.
  live.textContent = '';
  setTimeout(() => {
    live.textContent = message;
  }, 30);
  setTimeout(() => {
    if (live.textContent === message) live.textContent = '';
  }, 2000);
}

/** Copy, flash the check and say so. `button` is the one that shows the state. */
export async function copyWithFeedback(text: string, button: HTMLElement | null): Promise<boolean> {
  const ok = await copyToClipboard(text);
  announce(ok ? CODE_COPY.copied : CODE_COPY.copyFailed);
  if (button) {
    button.dataset.state = ok ? 'copied' : 'failed';
    setTimeout(() => delete button.dataset.state, RESET_MS);
  }
  return ok;
}

function closeMenus(except?: Element | null): void {
  for (const t of document.querySelectorAll<HTMLElement>(
    '[data-menu-toggle][aria-expanded="true"]',
  )) {
    if (t.closest('.menu') === except) continue;
    t.setAttribute('aria-expanded', 'false');
    t.closest('.menu')?.querySelector('.menu-list')?.setAttribute('hidden', '');
  }
}

/** "Copy as" and Wrap on prerendered blocks; the islands' React menus are their own. */
function onMenuClick(target: Element): boolean {
  const wrap = target.closest<HTMLElement>('[data-wrap-toggle]');
  if (wrap) {
    const on = wrap.getAttribute('aria-pressed') !== 'true';
    wrap.setAttribute('aria-pressed', String(on));
    wrap.closest('.code')?.toggleAttribute('data-wrap', on);
    return true;
  }
  const toggle = target.closest<HTMLElement>('[data-menu-toggle]');
  if (!toggle) {
    if (!target.closest('.menu')) closeMenus();
    return false;
  }
  const menu = toggle.closest('.menu');
  const open = toggle.getAttribute('aria-expanded') !== 'true';
  closeMenus(menu);
  toggle.setAttribute('aria-expanded', String(open));
  menu?.querySelector('.menu-list')?.toggleAttribute('hidden', !open);
  return true;
}

// Not the kit's copyText: that toasts through sonner and React, which the portal's first load cannot afford.
export function initCopy(): void {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = document.querySelector<HTMLElement>('[data-menu-toggle][aria-expanded="true"]');
    if (!open) return;
    closeMenus();
    open.focus();
  });
  document.addEventListener('click', async (event) => {
    const target = event.target as Element;
    if (onMenuClick(target)) return;
    const button = target.closest<HTMLElement>('[data-copy], [data-copy-as]');
    if (!button) return;
    const text = button.dataset.copyAs ? sampleFor(button) : textFor(button);
    const inMenu = button.closest('.menu');
    closeMenus();
    // A pick from the menu shows its state on the block's Copy button.
    const shown = inMenu
      ? (button.closest('.code')?.querySelector<HTMLElement>('.copy') ?? button)
      : button;
    await copyWithFeedback(text, shown);
  });
}
