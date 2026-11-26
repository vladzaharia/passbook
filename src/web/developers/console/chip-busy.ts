/** The page tells the chip an operation started; the chip looks, and rings while one runs. */
export const OPERATION_STARTED = 'passbook:operation-started';

const POLL_MS = 5000;

/**
 * Rings the sandbox chip (`data-busy`) while one of the person's sandbox operations is active. It reads
 * `GET /operations?active=true&mine=true` once, again whenever the page starts one, and every 5 s only while one runs.
 * It reads the same list the tray does, so it never claims more than the server says.
 */
export function watchBusy(chip: HTMLElement): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const look = async () => {
    clearTimeout(timer);
    if (!chip.isConnected) {
      window.removeEventListener(OPERATION_STARTED, look);
      return;
    }
    let busy = false;
    try {
      const res = await fetch('/api/v1/operations?active=true&mine=true', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      const body = res.ok ? ((await res.json()) as { items?: { kind?: string }[] }) : null;
      busy = (body?.items ?? []).some((op) => op.kind?.startsWith('sandbox.'));
    } catch {
      // Offline: the chip stays as it was; the tray and the page say the rest.
    }
    chip.dataset.busy = String(busy);
    if (busy) timer = setTimeout(() => void look(), POLL_MS);
  };
  window.addEventListener(OPERATION_STARTED, look);
  void look();
}
