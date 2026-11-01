import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  IconButton,
} from '../../ui/index.ts';

/** Page-header overflow: items are DropdownMenuItem children. */
export function MoreMenu({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton variant="outline" label="More" icon={<MoreHorizontal aria-hidden />} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
