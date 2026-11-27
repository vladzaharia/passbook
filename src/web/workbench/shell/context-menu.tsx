import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, BookOpen, Check, RotateCcw, Trash2 } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { WB_SANDBOX_COPY } from '@/shared/copy/workbench-sandbox.ts';
import { WB_SHELL_COPY } from '@/shared/copy/workbench-shell.ts';
import { PATHS } from '@/shared/developers.ts';
import { wbPath } from '@/shared/workbench.ts';
import { cn } from '../../lib/cn.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu.tsx';
import { keepTool, type WbContext } from '../host/contexts.ts';
import { adminLink } from '../host/tool-host.tsx';
import {
  type ContextSwitcherProps,
  Monogram,
  SWITCHER_TRIGGER,
  SwitcherFace,
  TestLine,
} from './switcher-face.tsx';

// The confirm and what follows it load when an action is chosen, not with the menu.
const Danger = lazy(() => import('../sandbox/danger.tsx'));

/** The switcher's menu (lazy): Switch, Go, and the sandbox's Danger group. */
export function ContextMenu({
  context,
  contexts,
  tool,
  onNavigate,
  defaultOpen,
}: ContextSwitcherProps & { defaultOpen: boolean }) {
  const navigate = useNavigate();
  const [act, setAct] = useState<'start-over' | 'delete' | null>(null);
  const [followId, setFollowId] = useState<string | null>(null);
  const go = (target: WbContext) => {
    onNavigate?.();
    if (target.orgId === context.orgId) return;
    void navigate({ to: wbPath(target.orgId, keepTool(target, tool ?? 'home')) });
  };
  return (
    <>
      <DropdownMenu modal={false} defaultOpen={defaultOpen}>
        <DropdownMenuTrigger className={SWITCHER_TRIGGER}>
          <SwitcherFace context={context} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) min-w-60"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>{WB_SHELL_COPY.switchGroup}</DropdownMenuLabel>
            {contexts.map((c) => (
              <DropdownMenuItem key={c.orgId} onSelect={() => go(c)} textValue={c.name}>
                <Monogram name={c.name} className="size-5 text-[0.625rem]" />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block truncate',
                      c.kind === 'sandbox' && 'font-mono text-[0.8125rem]',
                    )}
                  >
                    {c.name}
                  </span>
                  <TestLine context={c} />
                </span>
                {c.orgId === context.orgId ? (
                  <Check aria-hidden className="text-accent-fg!" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{WB_SHELL_COPY.goGroup}</DropdownMenuLabel>
            {/* Another space is another document: admin adopts mode=test on a full load. */}
            <DropdownMenuItem asChild>
              <a href={adminLink(context.orgId)}>
                <ArrowUpRight aria-hidden />
                {WB_SHELL_COPY.openInAdmin}
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={PATHS.home}>
                <BookOpen aria-hidden />
                {WB_SHELL_COPY.docs}
              </a>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {context.kind === 'sandbox' ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{WB_SANDBOX_COPY.dangerGroup}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setAct('start-over')}>
                  <RotateCcw aria-hidden />
                  {WB_SANDBOX_COPY.startOver}
                </DropdownMenuItem>
                <DropdownMenuItem destructive onSelect={() => setAct('delete')}>
                  <Trash2 aria-hidden />
                  {WB_SANDBOX_COPY.deleteSandbox}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {act || followId ? (
        <Suspense fallback={null}>
          <Danger
            act={act}
            followId={followId}
            onDone={() => setAct(null)}
            onStarted={setFollowId}
          />
        </Suspense>
      ) : null}
    </>
  );
}
