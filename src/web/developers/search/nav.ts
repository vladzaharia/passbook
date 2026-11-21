/** The two ways a result opens. Here so a test can see where a row would go. */
export const goTo = (href: string): void => window.location.assign(href);
export const openTab = (href: string): void => {
  window.open(href, '_blank', 'noopener');
};
