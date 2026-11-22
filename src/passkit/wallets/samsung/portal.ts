/**
 * The address a Samsung card's app link opens when the template names none (Q22): the
 * organization's website when it has set one, else the holder portal. Never a capability link.
 * The server and the designer preview both use this, so a preview shows the address a pass gets.
 */
export function samsungPortalUrl(origin: string, website?: string): string {
  const site = website?.trim();
  return site && /^https:\/\//u.test(site) ? site : `${origin.replace(/\/+$/u, '')}/account`;
}
