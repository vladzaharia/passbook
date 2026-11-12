import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { Button, Callout } from '../../../ui/index.ts';
import { DuplicateDialog } from '../template-dialogs.tsx';
import type { Template } from '../versions.ts';

/** Why a template cannot be designed, and the way out. */
export function ReadOnlyNotice({
  template: t,
  sharedReadOnly,
}: {
  template: Template;
  sharedReadOnly: boolean;
}) {
  const [duplicate, setDuplicate] = useState(false);
  const { orgId } = useOrgScope();
  const baked = t.origin === 'baked';
  const canDuplicate = baked || sharedReadOnly;
  return (
    <>
      <Callout
        className="mb-4"
        tone="info"
        actions={
          canDuplicate ? (
            <Button
              size="sm"
              iconStart={<ACTION_ICON.duplicate aria-hidden />}
              onClick={() => setDuplicate(true)}
            >
              Duplicate
            </Button>
          ) : (
            <Button asChild size="sm" variant="outline">
              <Link
                to="/admin/templates/$templateId"
                params={{ templateId: t.id }}
                search={{ orgId }}
              >
                Open template
              </Link>
            </Button>
          )
        }
      >
        {baked
          ? 'This template is read only. Duplicate it to design your own.'
          : sharedReadOnly
            ? 'Only platform administrators can change shared templates. Duplicate it to design your own.'
            : 'This template is archived. Restore requires an approved release.'}
      </Callout>
      {canDuplicate ? (
        <DuplicateDialog
          key={String(duplicate)}
          template={t}
          open={duplicate}
          onOpenChange={setDuplicate}
          to="design"
        />
      ) : null}
    </>
  );
}
