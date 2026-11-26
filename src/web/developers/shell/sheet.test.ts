import { afterEach, describe, expect, it, vi } from 'vitest';

const mountSheet = vi.fn();
vi.mock('../../workbench/console/run-entry.ts', () => ({
  mountSheet: (...a: unknown[]) => mountSheet(...a),
}));

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-sheet');
  mountSheet.mockReset();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** jsdom has no modal dialogs: a minimal showModal and close that fire the close event. */
function fakeDialogs() {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    },
  });
}

const slot = (data: Record<string, string>, title?: string) => {
  document.body.innerHTML = `<section class="op">${title ? `<h2>${title}</h2>` : ''}<div class="try" id="t"></div></section>`;
  const el = document.getElementById('t') as HTMLElement;
  Object.assign(el.dataset, data);
  return el;
};

describe('the Try it sheet', () => {
  it('opens for an operation slot, titled with the operation, and takes the console down on close', async () => {
    fakeDialogs();
    const unmount = vi.fn();
    mountSheet.mockResolvedValue(unmount);
    const { openSheet } = await import('./sheet.ts');
    await openSheet(slot({ slug: 'passes', op: 'create' }, 'Create a pass'));
    const dialog = document.querySelector<HTMLDialogElement>('dialog.sheet');
    expect(dialog?.open).toBe(true);
    expect(dialog?.querySelector('.h3')?.textContent).toBe('Try it: Create a pass');
    expect(document.documentElement.dataset.sheet).toBe('open');
    expect(mountSheet).toHaveBeenCalledWith(dialog?.querySelector('.sheet-b'), 'passes', 'create');
    // Opening again while open does nothing.
    await openSheet(slot({ slug: 'passes', op: 'create' }));
    expect(mountSheet).toHaveBeenCalledTimes(1);
    dialog?.querySelector<HTMLButtonElement>('button')?.click();
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.sheet).toBeUndefined();
  });

  it('closes on a tap on the dim area, not on the sheet itself, and reopens untitled', async () => {
    fakeDialogs();
    mountSheet.mockResolvedValue(vi.fn());
    const { openSheet } = await import('./sheet.ts');
    await openSheet(slot({ slug: 'a', op: 'b' }));
    const dialog = document.querySelector<HTMLDialogElement>('dialog.sheet');
    expect(dialog?.querySelector('.h3')?.textContent).toBe('Try it');
    dialog?.querySelector<HTMLElement>('.sheet-b')?.click();
    expect(dialog?.open).toBe(true);
    dialog?.click();
    expect(dialog?.open).toBe(false);
    await openSheet(slot({ slug: 'a', op: 'b' }, 'Again'));
    expect(dialog?.querySelector('.h3')?.textContent).toBe('Try it: Again');
  });

  it('ignores a slot with no operation', async () => {
    fakeDialogs();
    const { openSheet } = await import('./sheet.ts');
    await openSheet(slot({ slug: 'passes' }));
    expect(document.querySelector('dialog')).toBeNull();
    expect(mountSheet).not.toHaveBeenCalled();
  });
});
