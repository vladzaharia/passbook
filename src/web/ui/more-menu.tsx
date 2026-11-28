import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './dropdown-menu.tsx';
import { IconButton } from './icon-button.tsx';

/** Page-header overflow: items are DropdownMenuItem children. `iconOnly` keeps a tight head on one row. */
export function MoreMenu({
  children,
  iconOnly = false,
}: {
  children: ReactNode;
  iconOnly?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {iconOnly ? (
          <IconButton variant="outline" label="More" icon={<MoreHorizontal aria-hidden />} />
        ) : (
          <Button variant="outline" iconStart={<MoreHorizontal aria-hidden />}>
            <span>More</span>
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
