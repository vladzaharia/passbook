import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './dropdown-menu.tsx';

/** Page-header overflow: items are DropdownMenuItem children. */
export function MoreMenu({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" iconStart={<MoreHorizontal aria-hidden />}>
          <span className="max-sm:sr-only">More</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
