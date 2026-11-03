import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { archiveConfirm, deleteConfirm } from '../../lib/confirms.ts';
import { Button, Callout, ConfirmDialog, DropdownMenuItem, toast } from '../../ui/index.ts';
import { CreatedCallout } from '../passes/created.tsx';
import { useTemplateActions } from './api.ts';

type Template = z.infer<typeof TemplateDetailSchema>;

/**
 * Archive, restore and delete with the same guards everywhere: archive asks first (new passes
 * lose it) and offers Undo; Restore acts at once and its Undo archives again through that same
 * confirm, which lives on this page, so the offer goes when the page does. Delete asks plainly
 * (a template holds no one else's records) and leaves the page out of history.
 */
export function useTemplateLifecycle(t: Template) {
  const navigate = useNavigate();
  const actions = useTemplateActions(t.id);
  const [ask, setAsk] = useState<'archive' | 'delete' | null>(null);
  const offer = useRef<string | number | undefined>(undefined);
  useEffect(() => () => toast.dismiss(offer.current), []);

  async function restore() {
    try {
      await actions.archive.mutateAsync(false);
      offer.current = toast.undo('Template restored', () => setAsk('archive'));
    } catch (error) {
      toast.error(error, 'Could not restore');
    }
  }

  const close = (open: boolean) => !open && setAsk(null);
  const archived = t.status === 'archived';
  return {
    /** The More menu's Archive and Delete (Delete only while no pass uses it). */
    menu: (
      <>
        {archived ? null : (
          <DropdownMenuItem destructive onSelect={() => setAsk('archive')}>
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
    ),
    /** Above the stage while archived, with Restore. */
    notice: archived ? (
      <Callout
        tone="warning"
        className="mb-6"
        title="Archived"
        actions={
          <Button
            size="sm"
            variant="outline"
            iconStart={<ACTION_ICON.unvoid aria-hidden />}
            loading={actions.archive.isPending}
            onClick={() => void restore()}
          >
            Restore
          </Button>
        }
      >
        New passes cannot use it. Existing passes keep working.
      </Callout>
    ) : null,
    dialogs: (
      <>
        <ConfirmDialog
          open={ask === 'archive'}
          onOpenChange={close}
          {...archiveConfirm(t.name, t.passCount)}
          destructive
          onConfirm={async () => {
            await actions.archive.mutateAsync(true);
            offer.current = toast.undo('Template archived', () =>
              actions.archive.mutateAsync(false),
            );
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
            void navigate({ to: '/admin/templates', replace: true });
          }}
        />
      </>
    ),
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
  const older = t.passesOnOlderVersions;
  const title =
    how === 'duplicated'
      ? 'Template duplicated'
      : how === 'version'
        ? `${versionLabel ?? 'Version'} imported`
        : 'Template imported';
  return (
    <CreatedCallout
      title={title}
      onDismiss={onDismiss}
      actions={
        <>
          {older > 0 ? (
            <Button size="sm" asChild iconStart={<ACTION_ICON.refresh aria-hidden />}>
              <Link to="." search={{ tab: 'versions' }}>
                Update {older} {older === 1 ? 'pass' : 'passes'}
              </Link>
            </Button>
          ) : null}
          {how === 'duplicated' ? (
            <Button
              size="sm"
              variant="outline"
              asChild
              iconStart={<ACTION_ICON.upload aria-hidden />}
            >
              <Link to="/admin/templates/upload" search={{ templateId: t.id }}>
                Upload version
              </Link>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              asChild
              iconStart={<ACTION_ICON.upload aria-hidden />}
            >
              <Link to="/admin/templates/upload">Upload another</Link>
            </Button>
          )}
        </>
      }
    />
  );
}
