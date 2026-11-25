import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { type CSSProperties, useId } from 'react';
import { cn } from '../../lib/cn.ts';
import { hueOf } from '../avatar.tsx';
import { Badge } from '../badge.tsx';
import type { Choice } from './org-chooser-model.ts';
import { rolesLine } from './org-chooser-model.ts';
import { OrgMark, PlatformMark } from './scope-switcher.tsx';

/** The personal band takes the accent's hue, as its mark does; the platform's is slate blue. */
const PERSONAL_HUE = 178;
const PLATFORM_HUE = 250;
const WINDOWS = Array.from({ length: 12 }, (_, i) => i);

function bandStyle(choice: Choice, index: number): CSSProperties {
  if (choice.kind === 'platform') return { '--i': index, '--h': PLATFORM_HUE } as CSSProperties;
  const { membership } = choice;
  const hue = membership.personal ? PERSONAL_HUE : hueOf(membership.orgId);
  return { '--i': index, '--h': hue } as CSSProperties;
}

/**
 * An organization as an access badge: its colour band with the lanyard slot and the building's
 * windows, the mark over the band's edge, then the name, your roles and what sets it apart. The
 * name is the link and its overlay makes the whole card the target, so the link reads as the
 * organization and the rest describes it (WCAG 2.5.3). The windows light up on hover and focus,
 * and stay lit on the one you used last.
 */
export function OrgKeycard({ choice, index }: { choice: Choice; index: number }) {
  const id = useId();
  const org = choice.kind === 'org' ? choice.membership : undefined;
  const meta = org ? rolesLine(org.roles) : 'Platform admin';
  return (
    <li style={bandStyle(choice, index)} className="wl-kc-item flex min-w-0">
      <div
        data-lit={choice.last ? '' : undefined}
        className="wl-kc relative flex min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface-raised text-fg shadow-elevation-1 max-sm:flex-row sm:flex-col"
      >
        <span aria-hidden className="wl-kc-band">
          <span className="wl-kc-slot" />
          <span className="wl-kc-windows">
            {WINDOWS.map((w) => (
              <i key={w} />
            ))}
          </span>
          <span className="wl-kc-mark">
            {org ? <OrgMark org={org} size={48} /> : <PlatformMark size={48} />}
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1 px-4 pb-4 max-sm:py-3 sm:pt-7">
          <span className="flex min-w-0 items-center gap-2">
            <Link
              to={choice.to}
              data-choice=""
              title={choice.name}
              aria-describedby={choice.last ? `${id}-r ${id}-l` : `${id}-r`}
              className="wl-kc-link min-w-0 flex-1 truncate text-base font-semibold text-fg-strong"
            >
              {choice.name}
            </Link>
            <ArrowRight aria-hidden className="wl-kc-go size-4 shrink-0 text-fg-muted" />
          </span>
          <span className="flex min-w-0 flex-col gap-2">
            <span id={`${id}-r`} className="truncate text-xs text-fg-muted">
              {meta}
            </span>
            {choice.last ? (
              <span className="flex flex-wrap gap-1.5">
                <Badge id={`${id}-l`} tone="accent">
                  Last used
                </Badge>
              </span>
            ) : null}
          </span>
        </span>
      </div>
    </li>
  );
}

/** The cards' shape while grants load. */
export function KeycardSkeleton({ className }: { className?: string }) {
  return (
    <li aria-hidden className={cn('wl-kc-item flex min-w-0', className)}>
      <span className="wl-kc wl-kc-ghost flex min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface-raised max-sm:flex-row sm:flex-col">
        <span className="wl-kc-band wl-skeleton" />
        <span className="flex flex-1 flex-col gap-2 px-4 pb-4 max-sm:py-4 sm:pt-8">
          <span className="wl-skeleton h-4 w-2/3 rounded-md bg-state-hover-tint" />
          <span className="wl-skeleton h-3 w-1/2 rounded-md bg-state-hover-tint" />
        </span>
      </span>
    </li>
  );
}
