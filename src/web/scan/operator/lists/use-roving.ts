import { type KeyboardEvent, useCallback, useState } from 'react';

/**
 * One Tab stop for a list, arrows between its rows. The rows are the buttons marked
 * `data-roving` inside the list. Enter and Space act through the button itself.
 */
export function useRoving() {
  const [active, setActive] = useState(0);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    const home = event.key === 'Home' ? 0 : event.key === 'End' ? -1 : null;
    if (!step && home === null) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-roving]')];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (!rows.length || at < 0) return;
    event.preventDefault();
    const next =
      home !== null
        ? home < 0
          ? rows.length - 1
          : 0
        : Math.min(rows.length - 1, Math.max(0, at + step));
    rows[next]?.focus();
  }, []);
  return {
    onKeyDown,
    tabIndexOf: (index: number) => (index === active ? 0 : -1),
    onFocusRow: (index: number) => setActive(index),
  };
}
