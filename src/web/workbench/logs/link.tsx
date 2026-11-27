import { useRouter } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, MouseEvent } from 'react';

/** A link inside the Workbench: a plain click moves through the router, so the token and the shell stay. */
export function WbLink({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const router = useRouter({ warn: false });
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (!router || e.defaultPrevented || !href || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target === '_blank') return;
    e.preventDefault();
    router.history.push(href);
  };
  return <a href={href} onClick={go} {...rest} />;
}
