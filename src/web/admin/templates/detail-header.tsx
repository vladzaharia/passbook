import { Link } from '@tanstack/react-router';
import { Compass, Pencil, ScanLine } from 'lucide-react';
import type { ReactNode } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import {
  Badge,
  Button,
  type Crumb,
  DropdownMenuItem,
  DropdownMenuSeparator,
  MoreMenu,
  PageHeader,
  StatusPill,
} from '../../ui/index.ts';
import { originLabel } from './gallery.tsx';
import { isPrimary, nextAction } from './releases/next-action.ts';
import { ReleasePrimary } from './releases/release-primary.tsx';

type Template = z.infer<typeof TemplateDetailSchema>;

export function TemplateDetailHeader({
  template: t,
  crumbs,
  orgId: scopeOrgId,
  canAuthor,
  canEdit,
  canPublish,
  canOperate,
  lifecycleMenu,
  onDuplicate,
  onChangeOrg,
  onScanPasses,
  scanPending = false,
  draftName = '',
  onTry,
  onRelease,
  onReview,
  tryPending = false,
}: {
  template: Template;
  crumbs: Crumb[];
  orgId: string | undefined;
  canAuthor: boolean;
  canEdit: boolean;
  canPublish: boolean;
  canOperate: boolean;
  lifecycleMenu: ReactNode;
  onDuplicate: () => void;
  /** Set for a platform admin: reassigns the template to another organization. */
  onChangeOrg?: (() => void) | undefined;
  /** Set when the template can be scanned and the viewer manages scanning. */
  onScanPasses?: (() => void) | undefined;
  scanPending?: boolean;
  /** "v2": the newest saved version, named in the primary. */
  draftName?: string;
  onTry: () => void;
  onRelease: () => void;
  onReview: () => void;
  tryPending?: boolean;
}) {
  const baked = t.origin === 'baked';
  const archived = t.status === 'archived';
  const canDesign = canEdit || (baked && canAuthor);
  const hasLifecycle = canPublish && !baked && (!archived || t.passCount === 0);
  const orgId = t.orgId ?? scopeOrgId;
  const newPass = { ...(orgId ? { orgId } : {}), templateId: t.id };
  const next = archived || !t.release ? null : nextAction(t.release.next, draftName);
  const primary = next && isPrimary(next) ? next : null;
  const showNewPass = !archived && canOperate;
  const designLink = {
    to: '/admin/templates/$templateId/design',
    params: { templateId: t.id },
    search: { orgId: scopeOrgId },
  } as const;
  const newPassItem =
    showNewPass && primary ? (
      <DropdownMenuItem asChild>
        <Link to="/admin/passes/new" search={newPass}>
          <ACTION_ICON.create aria-hidden />
          New pass
        </Link>
      </DropdownMenuItem>
    ) : null;
  const hasMenu =
    Boolean(newPassItem) ||
    canAuthor ||
    hasLifecycle ||
    Boolean(onChangeOrg) ||
    Boolean(onScanPasses && !archived) ||
    (canDesign && !archived);

  return (
    <PageHeader
      title={t.name}
      breadcrumbs={crumbs}
      description={t.description ?? undefined}
      meta={
        <>
          <Badge>
            {t.fromBlueprint ? (
              <>
                <Compass aria-hidden className="size-3" />
                From {t.fromBlueprint.name}
              </>
            ) : (
              originLabel(t.origin)
            )}
          </Badge>
          {archived ? <StatusPill status="archived" /> : null}
          <span>
            {t.passCount} {t.passCount === 1 ? 'pass' : 'passes'}
          </span>
        </>
      }
      actions={
        <>
          {primary ? (
            <ReleasePrimary
              kind={primary.kind}
              label={primary.label}
              design={designLink}
              onTry={onTry}
              onRelease={onRelease}
              onReview={onReview}
              pending={tryPending}
            />
          ) : showNewPass ? (
            <Button
              asChild
              className="whitespace-nowrap"
              iconStart={<ACTION_ICON.create aria-hidden />}
            >
              <Link to="/admin/passes/new" search={newPass} aria-label="New pass">
                New pass
              </Link>
            </Button>
          ) : null}
          {archived || !canDesign || primary?.kind === 'design' ? null : (
            <Button
              asChild
              variant="outline"
              className="whitespace-nowrap max-md:hidden"
              iconStart={<ACTION_ICON.design aria-hidden />}
            >
              <Link {...designLink}>Design</Link>
            </Button>
          )}
          {hasMenu ? (
            <MoreMenu>
              {canDesign && !archived && primary?.kind !== 'design' ? (
                <DropdownMenuItem asChild className="md:hidden">
                  <Link {...designLink}>
                    <ACTION_ICON.design aria-hidden />
                    Design
                  </Link>
                </DropdownMenuItem>
              ) : null}
              {newPassItem}
              {archived || !onScanPasses ? null : (
                <DropdownMenuItem disabled={scanPending} onSelect={onScanPasses}>
                  <ScanLine aria-hidden />
                  Scan passes
                </DropdownMenuItem>
              )}
              {canEdit && !baked && !archived ? (
                <DropdownMenuItem asChild>
                  <Link
                    to="/admin/templates/upload"
                    search={{ templateId: t.id, orgId: scopeOrgId }}
                  >
                    <ACTION_ICON.upload aria-hidden />
                    Upload version
                  </Link>
                </DropdownMenuItem>
              ) : null}
              {canAuthor ? (
                <DropdownMenuItem onSelect={onDuplicate}>
                  <ACTION_ICON.duplicate aria-hidden />
                  Duplicate
                </DropdownMenuItem>
              ) : null}
              {onChangeOrg ? (
                <DropdownMenuItem onSelect={onChangeOrg}>
                  <Pencil aria-hidden />
                  Change organization
                </DropdownMenuItem>
              ) : null}
              {hasLifecycle ? (
                <>
                  <DropdownMenuSeparator />
                  {lifecycleMenu}
                </>
              ) : null}
            </MoreMenu>
          ) : null}
        </>
      }
    />
  );
}
