import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../../ui/index.ts';

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
