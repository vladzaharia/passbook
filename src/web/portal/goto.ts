/** Full-page navigation; a seam so tests can replace it (jsdom cannot navigate). */
export function goTo(href: string): void {
  window.location.assign(href);
}
