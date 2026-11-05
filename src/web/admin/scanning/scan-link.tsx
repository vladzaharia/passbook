import type { AnchorHTMLAttributes } from 'react';

/** /scan is its own document (scan.html), so a link to it is a plain anchor, never a router Link. */
export function ScanLink({
  event,
  ...props
}: { event?: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const href = event ? `/scan?event=${encodeURIComponent(event)}` : '/scan';
  return <a href={href} {...props} />;
}
