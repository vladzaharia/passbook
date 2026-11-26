import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ACTION_ICON } from '../../../../lib/action-icons.ts';
import { useOrgScope } from '../../../../lib/org-filter.tsx';
import { Button, Callout } from '../../../../ui/index.ts';
import { UseBlueprintDialog } from '../../../blueprints/use-dialog.tsx';
import { DuplicateDialog } from '../../template-dialogs.tsx';
import type { Template } from '../../versions.ts';

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
  if (t.blueprint) return <BlueprintNotice template={t} />;
  const canDuplicate = baked || sharedReadOnly;
  return (
    <>
      <Callout
        className="mb-4"
        tone="info"
        actionsAside
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

/** A blueprint is designed through Use blueprint: the template it makes is the org's own. */
function BlueprintNotice({ template: t }: { template: Template }) {
  const [using, setUsing] = useState(false);
  return (
    <>
      <Callout
        className="mb-4"
        tone="info"
        actionsAside
        actions={
          <Button
            size="sm"
            iconStart={<ACTION_ICON.create aria-hidden />}
            onClick={() => setUsing(true)}
          >
            Use blueprint
          </Button>
        }
      >
        Blueprints are read only. Use this one to design your own template.
      </Callout>
      <UseBlueprintDialog key={String(using)} blueprint={t} open={using} onOpenChange={setUsing} />
    </>
  );
}
