import { Link } from '@tanstack/react-router';
import { WB_SHELL_COPY } from '@/shared/copy/workbench-shell.ts';
import { BuddyFace } from '../../ui/art/face.tsx';

/**
 * The Workbench mark: the buddy's face and the name. It winks on hover; `cheer` changes when a
 * milestone lands (Quickstart done), and the face cheers once.
 */
export function WorkbenchMark({ to, cheer }: { to: string; cheer?: unknown }) {
  return (
    <Link
      to={to}
      className="group inline-flex min-h-8 items-center gap-2 rounded-md pr-1 text-[0.9375rem] font-semibold text-fg-strong pointer-coarse:min-h-11"
    >
      <BuddyFace
        size="md"
        scene={cheer === undefined ? 'wink' : 'cheer'}
        replay={cheer}
        className="size-7 shrink-0"
      />
      {WB_SHELL_COPY.mark}
    </Link>
  );
}
