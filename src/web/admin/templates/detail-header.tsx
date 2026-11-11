import { Link } from '@tanstack/react-router';
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
}) {
  const baked = t.origin === 'baked';
  const archived = t.status === 'archived';
  const canDesign = canEdit || (baked && canAuthor);
  const hasLifecycle = canPublish && !baked && (!archived || t.passCount === 0);
  const mobileOnlyMenu = !hasLifecycle && !(canEdit && !baked && !archived);
  const orgId = t.orgId ?? scopeOrgId;
  const newPass = { ...(orgId ? { orgId } : {}), templateId: t.id };

  return (
    <PageHeader
      title={t.name}
      breadcrumbs={crumbs}
      description={t.description ?? undefined}
      meta={
        <>
          <Badge>{originLabel(t.origin)}</Badge>
          {archived ? <StatusPill status="archived" /> : null}
          <span>
            {t.passCount} {t.passCount === 1 ? 'pass' : 'passes'}
          </span>
        </>
      }
      actions={
        <>
          {archived || !canOperate ? null : (
            <Button
              asChild
              className="whitespace-nowrap"
              iconStart={<ACTION_ICON.create aria-hidden />}
            >
              <Link to="/admin/passes/new" search={newPass} aria-label="New pass">
                New<span className="max-md:sr-only"> pass</span>
              </Link>
            </Button>
          )}
          {archived || !canDesign ? null : (
            <Button
              asChild
              variant="outline"
              className="whitespace-nowrap max-md:hidden"
              iconStart={<ACTION_ICON.design aria-hidden />}
            >
              <Link
                to="/admin/templates/$templateId/design"
                params={{ templateId: t.id }}
                search={{ orgId: scopeOrgId }}
              >
                Design
              </Link>
            </Button>
          )}
          {canAuthor ? (
            <Button
              variant="outline"
              className="whitespace-nowrap max-md:hidden"
              iconStart={<ACTION_ICON.duplicate aria-hidden />}
              onClick={onDuplicate}
            >
              Duplicate
            </Button>
          ) : null}
          {/* Phones keep Design and Duplicate in the menu. */}
          {canAuthor || hasLifecycle ? (
            <div className={mobileOnlyMenu ? 'contents md:hidden' : 'contents'}>
              <MoreMenu>
                {canDesign && !archived ? (
                  <DropdownMenuItem asChild className="md:hidden">
                    <Link
                      to="/admin/templates/$templateId/design"
                      params={{ templateId: t.id }}
                      search={{ orgId: scopeOrgId }}
                    >
                      <ACTION_ICON.design aria-hidden />
                      Design
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {canAuthor ? (
                  <DropdownMenuItem className="md:hidden" onSelect={onDuplicate}>
                    <ACTION_ICON.duplicate aria-hidden />
                    Duplicate
                  </DropdownMenuItem>
                ) : null}
                {canEdit && !baked && !archived ? (
                  <>
                    <DropdownMenuSeparator className="md:hidden" />
                    <DropdownMenuItem asChild>
                      <Link
                        to="/admin/templates/upload"
                        search={{ templateId: t.id, orgId: scopeOrgId }}
                      >
                        <ACTION_ICON.upload aria-hidden />
                        Upload version
                      </Link>
                    </DropdownMenuItem>
                  </>
                ) : null}
                {hasLifecycle ? (
                  <>
                    {canAuthor ? <DropdownMenuSeparator /> : null}
                    {lifecycleMenu}
                  </>
                ) : null}
              </MoreMenu>
            </div>
          ) : null}
        </>
      }
    />
  );
}
