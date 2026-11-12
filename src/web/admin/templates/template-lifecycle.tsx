import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { archiveConfirm, deleteConfirm } from '../../lib/confirms.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { Button, Callout, ConfirmDialog, DropdownMenuItem, toast } from '../../ui/index.ts';
import { CreatedCallout } from '../passes/created.tsx';
import { useTemplateActions } from './api.ts';

type Template = z.infer<typeof TemplateDetailSchema>;

/** Archive, delete and restore; a template with release history is restored by a rollback. */
export function useTemplateLifecycle(t: Template, canPublish: boolean) {
  const navigate = useNavigate();
  const { orgId } = useOrgScope();
  const actions = useTemplateActions(t.id);
  const [ask, setAsk] = useState<'archive' | 'delete' | null>(null);

  const close = (open: boolean) => !open && setAsk(null);
  const archived = t.status === 'archived';
  // canPublish already requires a platform admin for a shared template, as the server does.
  const canRestore = t.restorable && canPublish;
  async function restore() {
    try {
      await actions.archive.mutateAsync(false);
      toast.success('Template restored');
    } catch (cause) {
      toast.error(cause, 'Could not restore');
    }
  }
  return {
    /** The More menu's Archive and Delete (Delete only while no pass uses it). */
    menu: canPublish ? (
      <>
        {archived ? null : (
          <DropdownMenuItem onSelect={() => setAsk('archive')}>
            <ACTION_ICON.void aria-hidden />
            Archive
          </DropdownMenuItem>
        )}
        {t.passCount === 0 ? (
          <DropdownMenuItem destructive onSelect={() => setAsk('delete')}>
            <ACTION_ICON.delete aria-hidden />
            Delete
          </DropdownMenuItem>
        ) : null}
      </>
    ) : null,
    /** Above the stage while archived: Restore when the server allows it, else where to go. */
    notice: archived ? (
      <Callout
        tone="warning"
        className="mb-6"
        title="Archived"
        actions={
          canRestore ? (
            <Button
              size="sm"
              variant="outline"
              loading={actions.archive.isPending}
              iconStart={<ACTION_ICON.unvoid aria-hidden />}
              onClick={() => void restore()}
            >
              Restore
            </Button>
          ) : undefined
        }
      >
        New passes cannot use it. Existing passes keep working.
        {canRestore ? null : (
          <span>
            {' '}
            {!t.restorable
              ? 'Restore it with a rollback in Releases.'
              : t.orgId === null
                ? 'Ask a platform admin to restore it.'
                : 'Ask a publisher to restore it.'}
          </span>
        )}
      </Callout>
    ) : null,
    dialogs: canPublish ? (
      <>
        <ConfirmDialog
          open={ask === 'archive'}
          onOpenChange={close}
          {...archiveConfirm(t.name, t.passCount)}
          onConfirm={async () => {
            await actions.archive.mutateAsync(true);
            toast.success('Template archived');
          }}
        />
        <ConfirmDialog
          open={ask === 'delete'}
          onOpenChange={close}
          {...deleteConfirm('template', t.name)}
          destructive
          onConfirm={async () => {
            await actions.remove.mutateAsync();
            toast.success('Template deleted');
            void navigate({ to: '/admin/templates', search: { orgId }, replace: true });
          }}
        />
      </>
    ) : null,
  };
}

/** How the template page was reached from a create flow (markCreated `template:<id>`). */
export type TemplateCreated = 'imported' | 'version' | 'duplicated';

/** After an upload or a duplicate: what happened and the next steps, until dismissed. */
export function TemplateCreatedCallout({
  template: t,
  how,
  versionLabel,
  onDismiss,
}: {
  template: Template;
  how: TemplateCreated;
  versionLabel: string | null;
  onDismiss: () => void;
}) {
  const { orgId } = useOrgScope();
  const what =
    how === 'duplicated'
      ? 'Template duplicated'
      : how === 'version'
        ? `${versionLabel ?? 'Version'} imported`
        : 'Template imported';
  const title = what;
  return (
    <CreatedCallout
      title={title}
      onDismiss={onDismiss}
      actions={
        how === 'duplicated' ? (
          <Button
            size="sm"
            variant="outline"
            asChild
            iconStart={<ACTION_ICON.upload aria-hidden />}
          >
            <Link to="/admin/templates/upload" search={{ templateId: t.id, orgId }}>
              Upload version
            </Link>
          </Button>
        ) : (
          <Button size="sm" variant="ghost" asChild iconStart={<ACTION_ICON.upload aria-hidden />}>
            <Link to="/admin/templates/upload" search={{ orgId }}>
              Upload another
            </Link>
          </Button>
        )
      }
    />
  );
}
