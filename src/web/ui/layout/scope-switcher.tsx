import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Link } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Globe, RefreshCw, User } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { cn } from '../../lib/cn.ts';
import { useAdminScope, useOrgScope } from '../../lib/org-filter.tsx';
import { orgPath } from '../../lib/scope.ts';
import { useSession } from '../../lib/session.ts';
import { Button } from '../button.tsx';
import { EntityAvatar } from '../entity.tsx';
import { CONTROL, CONTROL_HEIGHT } from '../input.tsx';

const ITEM =
  'flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm text-fg pointer-coarse:min-h-11 data-[selected=true]:bg-state-hover-tint data-[selected=true]:text-fg-strong';
const GROUP =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-fg-muted';

const MARK = 'flex shrink-0 items-center justify-center bg-accent-subtle text-accent-fg';
/** 24 in rows and the switcher; 48 on the chooser's cards. */
const MARK_SIZE = {
  24: 'size-6 rounded-md [&_svg]:size-4',
  48: 'size-12 rounded-lg [&_svg]:size-6',
} as const;
type MarkSize = keyof typeof MARK_SIZE;

export function PlatformMark({ size = 24 }: { size?: MarkSize }) {
  return (
    <span className={cn(MARK, MARK_SIZE[size])}>
      <Globe aria-hidden />
    </span>
  );
}

export function PersonalMark({ size = 24 }: { size?: MarkSize }) {
  return (
    <span className={cn(MARK, MARK_SIZE[size])}>
      <User aria-hidden />
    </span>
  );
}

/** The mark of an organization as a scope: the user tile for a personal one, else its avatar. */
export function OrgMark({
  org,
  size = 24,
}: {
  org: Pick<OrgMembership, 'orgId' | 'orgName' | 'personal'>;
  size?: MarkSize;
}) {
  return org.personal ? (
    <PersonalMark size={size} />
  ) : (
    <EntityAvatar
      kind="org"
      id={org.orgId}
      name={org.orgName}
      size={size}
      className={size === 48 ? 'text-xl' : undefined}
    />
  );
}

function Item({
  current,
  icon,
  label,
  onSelect,
}: {
  current: boolean;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item value={label} onSelect={onSelect} className={ITEM}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Check
        aria-hidden
        className={cn('size-4 shrink-0 text-accent-fg', current ? 'opacity-100' : 'opacity-0')}
      />
    </Command.Item>
  );
}

/**
 * Heads the sidebar: Platform (platform admins), then the principal's organizations. Choosing
 * one opens the same section there when it has it. The URL is the scope; this only navigates.
 */
export function ScopeSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const scope = useAdminScope();
  const { isAdmin } = useSession();
  const {
    choices: memberships,
    membership,
    switchScope,
    isLoading,
    isError,
    refetch,
  } = useOrgScope();
  const [open, setOpen] = useState(false);
  if (isLoading) {
    return (
      <p role="status" className="flex h-9 items-center text-xs text-fg-muted">
        Loading organizations…
      </p>
    );
  }
  if (isError && !isAdmin) {
    return (
      <Button
        variant="outline"
        size="sm"
        iconStart={<RefreshCw aria-hidden />}
        onClick={() => void refetch()}
      >
        Retry organizations
      </Button>
    );
  }
  // Platform is a scope only for platform admins; anyone else is offered their organizations.
  const platform = scope?.kind === 'platform' && isAdmin;
  const name = platform ? 'Platform' : (membership?.orgName ?? undefined);
  const icon = platform ? <PlatformMark /> : membership ? <OrgMark org={membership} /> : null;
  const personal = memberships.find((m) => m.personal);
  const others = memberships.filter((m) => !m.personal);
  const choose = (run: () => void) => () => {
    setOpen(false);
    onNavigate?.();
    run();
  };
  const failed = isError ? (
    <span role="alert" className="sr-only">
      Could not load organization access.
    </span>
  ) : null;
  // One reachable scope: a label, not a menu; from outside it, a link into it.
  const only = !isAdmin && memberships.length === 1 ? memberships[0] : undefined;
  if (only && !name) {
    return (
      <Link
        to={orgPath(only.orgId)}
        onClick={onNavigate}
        className="flex h-9 min-w-0 items-center gap-2 rounded-md text-sm font-medium text-fg-strong hover:underline"
      >
        {failed}
        <OrgMark org={only} />
        <span className="truncate">{only.orgName}</span>
      </Link>
    );
  }
  if ((isAdmin ? 1 : 0) + memberships.length <= 1 && name) {
    return (
      <p className="flex h-9 min-w-0 items-center gap-2 text-sm font-medium text-fg-strong">
        {failed}
        {icon}
        <span className="truncate">{name}</span>
      </p>
    );
  }
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      {failed}
      <PopoverPrimitive.Trigger
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        // The accessible name contains the visible value (WCAG 2.5.3).
        aria-label={`Scope: ${name ?? 'Choose an organization'}`}
        className={cn(CONTROL, CONTROL_HEIGHT, 'flex items-center justify-between gap-2 px-2')}
      >
        <span className="flex min-w-0 items-center gap-2">
          {icon}
          <span className={cn('truncate', name ? 'font-medium text-fg-strong' : 'text-fg-subtle')}>
            {name ?? 'Choose an organization'}
          </span>
        </span>
        <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-fg-muted" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          collisionPadding={16}
          aria-label="Organizations"
          className="wl-pop origin-(--radix-popover-content-transform-origin) z-50 w-(--radix-popover-trigger-width) min-w-60 rounded-md border border-border bg-surface-overlay shadow-elevation-2"
        >
          <Command>
            <Command.Input
              placeholder="Find an organization"
              aria-label="Find an organization"
              className="h-9 w-full border-b border-border bg-transparent px-3 text-sm text-fg outline-hidden placeholder:text-fg-subtle pointer-coarse:h-11 pointer-coarse:text-[max(16px,1rem)]"
            />
            <Command.List className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height)_-_2.5rem))] overflow-auto overscroll-contain p-1">
              <Command.Empty className="px-3 py-2 text-sm text-fg-muted">No results</Command.Empty>
              {isAdmin || personal ? (
                <Command.Group className={GROUP}>
                  {isAdmin ? (
                    <Item
                      current={platform}
                      icon={<PlatformMark />}
                      label="Platform"
                      onSelect={choose(() => switchScope(undefined))}
                    />
                  ) : null}
                  {personal ? (
                    <Item
                      current={membership?.orgId === personal.orgId}
                      icon={<OrgMark org={personal} />}
                      label={personal.orgName}
                      onSelect={choose(() => switchScope(personal.orgId))}
                    />
                  ) : null}
                </Command.Group>
              ) : null}
              {(isAdmin || personal) && others.length > 0 ? (
                <Command.Separator alwaysRender aria-hidden className="mx-1 my-1 h-px bg-border" />
              ) : null}
              {others.length > 0 ? (
                <Command.Group heading="Organizations" className={GROUP}>
                  {others.map((m) => (
                    <Item
                      key={m.orgId}
                      current={membership?.orgId === m.orgId}
                      icon={<OrgMark org={m} />}
                      label={m.orgName}
                      onSelect={choose(() => switchScope(m.orgId))}
                    />
                  ))}
                </Command.Group>
              ) : null}
              {isError ? (
                <Command.Item onSelect={() => void refetch()} className={ITEM}>
                  <RefreshCw aria-hidden className="size-4 text-fg-muted" />
                  Retry organizations
                </Command.Item>
              ) : null}
            </Command.List>
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
