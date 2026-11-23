import { type RefObject, useLayoutEffect } from 'react';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

/**
 * A card body that scrolls with nothing in it to focus gets a tab stop while it overflows, so a
 * keyboard can scroll it (a phone on its side cuts a card short). The body is the card's
 * `.scan-result-body`; it follows size changes and what is in it.
 */
export function useScrollTabStop(card: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const body = card.current?.querySelector<HTMLElement>('.scan-result-body');
    if (!body) return;
    const update = () => {
      const over = body.scrollHeight - body.clientHeight > 1;
      if (over && !body.querySelector(FOCUSABLE)) body.tabIndex = 0;
      else body.removeAttribute('tabindex');
    };
    update();
    const size = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    size?.observe(body);
    const content = new MutationObserver(update);
    content.observe(body, { childList: true, subtree: true });
    return () => {
      size?.disconnect();
      content.disconnect();
    };
  }, [card]);
}
