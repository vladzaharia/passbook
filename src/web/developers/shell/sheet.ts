import { mountSheet } from '../../workbench/console/run-entry.ts';

let dialog: HTMLDialogElement | undefined;
let body: HTMLElement | undefined;
let heading: HTMLElement | undefined;
let unmount: (() => void) | undefined;

function build(): HTMLDialogElement {
  const d = document.createElement('dialog');
  d.className = 'sheet';
  d.setAttribute('aria-label', 'Try it');
  const head = document.createElement('div');
  head.className = 'sheet-h';
  const grab = document.createElement('span');
  grab.className = 'sheet-grab';
  grab.setAttribute('aria-hidden', 'true');
  heading = document.createElement('span');
  heading.className = 'h3';
  heading.textContent = 'Try it';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn ghost sm';
  close.textContent = 'Close';
  close.addEventListener('click', () => d.close());
  head.append(grab, heading, close);
  body = document.createElement('div');
  body.className = 'sheet-b';
  d.append(head, body);
  // A tap on the dim area outside the sheet closes it.
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
  d.addEventListener('close', () => {
    unmount?.();
    unmount = undefined;
    document.documentElement.removeAttribute('data-sheet');
  });
  document.body.append(d);
  return d;
}

/** Opens the console for one operation's slot as a bottom sheet. */
export async function openSheet(slot: HTMLElement): Promise<void> {
  const { slug, op } = slot.dataset;
  if (!slug || !op) return;
  dialog ??= build();
  if (dialog.open) return;
  const name = slot.closest('.op')?.querySelector('h1, h2')?.textContent;
  if (heading) heading.textContent = name ? `Try it: ${name}` : 'Try it';
  document.documentElement.dataset.sheet = 'open';
  dialog.showModal();
  unmount = await mountSheet(body as HTMLElement, slug, op);
}
