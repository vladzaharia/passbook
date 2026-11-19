import { Link } from '@tanstack/react-router';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button.tsx';

export { CARD_SURFACE, Card, CardBody, CardHeader } from './card-base.tsx';

/**
 * A card-header action: ghost sm with ChevronRight for an internal page, ArrowUpRight for an
 * external one. Never an underlined link.
 */
export function CardLink({
  to,
  href,
  children,
}: {
  to?: string;
  href?: string;
  children: ReactNode;
}) {
  if (href) {
    return (
      <Button asChild variant="ghost" size="sm" iconEnd={<ArrowUpRight aria-hidden />}>
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      </Button>
    );
  }
  return (
    <Button asChild variant="ghost" size="sm" iconEnd={<ChevronRight aria-hidden />}>
      <Link to={to ?? '/'}>{children}</Link>
    </Button>
  );
}
