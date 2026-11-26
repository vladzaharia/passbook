/** True while the person is typing: a field, a select or an editable region has focus. */
export const typing = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement &&
  !!el.closest(
    'input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]',
  );
