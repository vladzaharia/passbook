import { Link } from '@tanstack/react-router';
import { ArrowUpRight, KeyRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { POLARIS_ID_COPY } from '@/shared/copy/auth-page.ts';
import { wbLabel } from '@/shared/copy/workbench-shell.ts';
import { WB_EMPTY, WB_STATES } from '@/shared/copy/workbench-states.ts';
import { MARKETING_PATHS } from '@/shared/marketing.ts';
import { type WbTool, wbPath } from '@/shared/workbench.ts';
import { cn } from '../../lib/cn.ts';
import { ApiError } from '../../lib/errors.ts';
import { Buddy, type BuddyScene, type WalletMood } from '../../ui/art/index.ts';
import { Button } from '../../ui/button.tsx';
import { EmptyState, STAGE_SURFACE } from '../../ui/empty-state.tsx';
import { ErrorState } from '../../ui/error-state.tsx';
import { NoAccessState } from '../../ui/no-access-state.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import { adminLink } from '../host/tool-host.tsx';
import { AREA_ICON } from '../shell/nav-model.ts';

/** One title scale for every Workbench state, heading or not. */
export const STATE_TITLE = 'text-base font-semibold text-fg-strong';

/** The buddy on the stage, one line, one way on: the Workbench's own states (design §6). */
export function StageState({
  scene,
  mood = 'happy',
  title,
  heading = false,
  action,
  children,
}: {
  scene: BuddyScene;
  mood?: WalletMood;
  title: string;
  heading?: boolean;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const Title = heading ? 'h1' : 'p';
  return (
    <div
      data-art-host=""
      className={cn('flex flex-col items-center gap-2 px-6 py-10 text-center', STAGE_SURFACE)}
    >
      <div aria-hidden className="relative mt-[4.5rem] mb-1 h-0 w-full">
        <Buddy mood={mood} scene={scene} state="login" />
      </div>
      <Title tabIndex={heading ? -1 : undefined} className={cn('outline-none', STATE_TITLE)}>
        {title}
      </Title>
      {children}
      {action ? (
        <div className="mt-2 flex justify-center max-sm:w-full max-sm:[&>*]:w-full">{action}</div>
      ) : null}
    </div>
  );
}

/** Signed out, every area but Design and Quickstart: the one sign-in state, back to this URL. */
export function SignInState({ next }: { next: string }) {
  return (
    <StageState
      heading
      scene="wave"
      title={WB_STATES.signedOut.title}
      action={
        <Button asChild iconStart={<KeyRound aria-hidden />}>
          <a href={`/auth/oidc/start?next=${encodeURIComponent(next)}`}>{POLARIS_ID_COPY.signIn}</a>
        </Button>
      }
    />
  );
}

/** Signed in, but no developer role and no org whose Test this person may use. */
export function NoWorkbenchAccess() {
  return (
    <NoAccessState
      heading
      titleClassName={STATE_TITLE}
      title={WB_STATES.noAccess.title}
      actions={
        <Button asChild variant="outline">
          <a href={MARKETING_PATHS.access}>{WB_STATES.noAccess.action}</a>
        </Button>
      }
    />
  );
}

/** A path naming a sandbox or org that is not one of this person's contexts. */
export function ContextNotFound() {
  return (
    <NoAccessState
      heading
      titleClassName={STATE_TITLE}
      title={WB_STATES.notFound.title}
      actions={
        <Button asChild variant="outline">
          <Link to="/workbench">{WB_STATES.notFound.action}</Link>
        </Button>
      }
    />
  );
}

const NAME_MAX = 24;
/** An org name long enough to wrap the heading to three lines at 390 reads cut short. */
const shortName = (name: string): string =>
  name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1).trimEnd()}…` : name;

/**
 * A deep link to an area this org's Test does not allow: the area is absent from the nav, so this
 * names it, offers the nearest allowed area and admin (design §6). Never a 403 page.
 */
export function ToolNotAllowed({
  orgId,
  orgName,
  nearest,
}: {
  orgId: string;
  orgName: string;
  nearest: WbTool;
}) {
  const Icon = AREA_ICON[nearest];
  return (
    <NoAccessState
      heading
      titleClassName={cn(STATE_TITLE, 'max-w-full line-clamp-2 break-words')}
      title={WB_STATES.notAllowed.title(shortName(orgName))}
      actions={
        <>
          <Button asChild variant="outline" iconStart={<Icon aria-hidden />}>
            <Link to={wbPath(orgId, nearest)}>
              {WB_STATES.notAllowed.nearest(wbLabel(nearest))}
            </Link>
          </Button>
          <Button asChild variant="outline" iconStart={<ArrowUpRight aria-hidden />}>
            <a href={adminLink(orgId)}>{WB_STATES.notAllowed.admin}</a>
          </Button>
        </>
      }
    />
  );
}

/** A developer with no sandbox yet: Quickstart makes one. */
export function NoSandboxState() {
  return (
    <StageState
      heading
      scene="nudge"
      mood="curious"
      title={WB_STATES.noSandbox.title}
      action={
        <Button asChild>
          <Link to="/workbench/quickstart">{WB_STATES.noSandbox.action}</Link>
        </Button>
      }
    />
  );
}

/** A tool's list with nothing in it yet: its own line and action (design §6 per-tool table). */
export function ToolEmpty({ tool, action }: { tool: WbTool; action?: ReactNode }) {
  const empty = WB_EMPTY[tool];
  if (!empty) return null;
  return (
    <EmptyState
      art={empty.art}
      surface="stage"
      titleClassName={STATE_TITLE}
      title={empty.title}
      action={
        action ? (
          <div className="flex justify-center [&>*]:justify-center">{action}</div>
        ) : undefined
      }
    />
  );
}

/** The kind of failure in one line: the network, access or the server. */
export function failedLine(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return WB_STATES.failed.network;
    if (error.status === 401 || error.status === 403) return WB_STATES.failed.access;
  }
  return WB_STATES.failed.server;
}

/** A failed load: one line saying what failed, and Retry. */
export function ToolFailed({ error, onRetry }: { error: unknown; onRetry: () => unknown }) {
  return (
    <ErrorState
      error={error}
      title={failedLine(error)}
      titleClassName={STATE_TITLE}
      onRetry={onRetry}
    />
  );
}

/** Mid-reset: a status skeleton reading "Resetting", not focusable; the tray carries progress. */
export function ResettingState() {
  return (
    <div role="status" aria-busy className="flex flex-col gap-2">
      <p className="text-sm text-fg-muted">{WB_STATES.resetting}</p>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

/** The sandbox is closed: one line on the stage. */
export function ClosedState() {
  return <StageState scene="beat" mood="flat" title={WB_STATES.sandboxClosed.title} />;
}
